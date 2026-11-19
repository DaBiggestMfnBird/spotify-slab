#include "slab_sound.h"

#include "signalsmith-stretch.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <vector>

namespace {

constexpr double kTwoPi = 6.283185307179586;

template <class T>
T clampTo(T value, T low, T high) {
    return std::max(low, std::min(high, value));
}

/// Two channels in the shape the stretcher reads and writes.
struct Input {
    const float *channel[2];
    const float *operator[](int c) const { return channel[c]; }
};
struct Output {
    float *channel[2];
    float *operator[](int c) const { return channel[c]; }
};

/// A one-pole smoother's coefficient: about `ms` to get most of the way.
float smoothing(double sampleRate, double ms) {
    return float(1 - std::exp(-1000 / (ms * sampleRate)));
}

/// The low-pass: second-order Butterworth, as the macOS helper's EQ band is.
struct LowPass {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double z1[2] = {0, 0};
    double z2[2] = {0, 0};

    void set(double sampleRate, double hz) {
        const double w = kTwoPi * hz / sampleRate;
        const double cw = std::cos(w);
        const double alpha = std::sin(w) / (2 * 0.7071067811865476);
        const double a0 = 1 + alpha;
        b0 = (1 - cw) / 2 / a0;
        b1 = (1 - cw) / a0;
        b2 = b0;
        a1 = -2 * cw / a0;
        a2 = (1 - alpha) / a0;
    }

    float run(int c, float x) {
        const double y = b0 * x + z1[c];
        z1[c] = b1 * x - a1 * y + z2[c];
        z2[c] = b2 * x - a2 * y;
        return float(y);
    }

    void clear() { z1[0] = z1[1] = z2[0] = z2[1] = 0; }
};

/// A room's character: how long it rings (to -60 dB), how big it is against Freeverb's tuning,
/// how fast its highs die, and how long before the first of it comes back.
struct RoomShape {
    double seconds;
    double size;
    double damp;
    double preDelayMs;
};

/// Indexed by SLAB_ROOM_*. Shaped after the macOS factory presets of the same names.
constexpr RoomShape kRooms[SLAB_ROOM_COUNT] = {
    {2.6, 1.25, 0.35, 25},  // large hall 2
    {0.45, 0.55, 0.45, 4},  // small room
    {0.75, 0.75, 0.45, 8},  // medium room
    {1.1, 0.95, 0.4, 12},   // large room
    {1.7, 1.1, 0.35, 18},   // medium hall
    {2.3, 1.25, 0.35, 22},  // large hall
    {1.5, 0.8, 0.12, 1},    // plate
    {4.5, 1.5, 0.4, 35},    // cathedral
    {1.2, 0.85, 0.25, 10},  // medium chamber
    {1.7, 1.0, 0.25, 14},   // large chamber
};

/// The room: Freeverb's eight combs and four all-passes a side, each comb's feedback set so it
/// rings for the room's time, and the whole scaled so a steady sound comes back about as loud
/// as it went in.
class Room {
public:
    void init(double sampleRate) {
        rate = sampleRate;
        const double most = 1.5 * sampleRate / 44100;
        for (int c = 0; c < 2; ++c) {
            for (int i = 0; i < 8; ++i) combs[c][i].buffer.assign(size_t((kComb[i] + kSpread) * most) + 2, 0);
            for (int i = 0; i < 4; ++i) passes[c][i].buffer.assign(size_t((kPass[i] + kSpread) * most) + 2, 0);
        }
        pre.assign(size_t(0.05 * sampleRate) + 2, 0);
        tune(SLAB_ROOM_LARGE_HALL_2);
    }

    void tune(int preset) {
        const RoomShape &shape = kRooms[clampTo(preset, 0, SLAB_ROOM_COUNT - 1)];
        const double scale = shape.size * rate / 44100;
        double power = 0;
        for (int c = 0; c < 2; ++c) {
            const int spread = c ? kSpread : 0;
            for (int i = 0; i < 8; ++i) {
                Comb &comb = combs[c][i];
                comb.length = std::max(1, int((kComb[i] + spread) * scale));
                const double g = std::pow(10.0, -3.0 * comb.length / (shape.seconds * rate));
                comb.feedback = float(g);
                comb.damp = float(shape.damp);
                if (c == 0) power += 1 / (1 - g * g);
            }
            for (int i = 0; i < 4; ++i) passes[c][i].length = std::max(1, int((kPass[i] + spread) * scale));
        }
        gain = float(1 / std::sqrt(power));
        preLength = clampTo(int(shape.preDelayMs * rate / 1000), 1, int(pre.size()));
        clear();
    }

    void clear() {
        for (auto &side : combs) {
            for (Comb &comb : side) {
                std::fill(comb.buffer.begin(), comb.buffer.end(), 0.0f);
                comb.at = 0;
                comb.store = 0;
            }
        }
        for (auto &side : passes) {
            for (Pass &pass : side) {
                std::fill(pass.buffer.begin(), pass.buffer.end(), 0.0f);
                pass.at = 0;
            }
        }
        std::fill(pre.begin(), pre.end(), 0.0f);
        preAt = 0;
    }

    void run(float inL, float inR, float &outL, float &outR) {
        const float x = pre[preAt] * gain;
        pre[preAt] = (inL + inR) * 0.5f;
        if (++preAt >= preLength) preAt = 0;
        float sums[2];
        for (int c = 0; c < 2; ++c) {
            float sum = 0;
            for (Comb &comb : combs[c]) sum += comb.run(x);
            for (Pass &pass : passes[c]) sum = pass.run(sum);
            sums[c] = sum;
        }
        outL = sums[0];
        outR = sums[1];
    }

private:
    static constexpr int kComb[8] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
    static constexpr int kPass[4] = {556, 441, 341, 225};
    static constexpr int kSpread = 23;

    struct Comb {
        std::vector<float> buffer;
        int length = 1;
        int at = 0;
        float store = 0;
        float feedback = 0;
        float damp = 0;

        float run(float x) {
            const float y = buffer[at];
            store = y * (1 - damp) + store * damp;
            buffer[at] = x + store * feedback;
            if (++at >= length) at = 0;
            return y;
        }
    };

    /// A true all-pass (Schroeder's), so the room's level is the combs' alone.
    struct Pass {
        std::vector<float> buffer;
        int length = 1;
        int at = 0;

        float run(float x) {
            const float back = buffer[at];
            const float v = x + 0.5f * back;
            buffer[at] = v;
            if (++at >= length) at = 0;
            return back - 0.5f * v;
        }
    };

    double rate = 48000;
    Comb combs[2][8];
    Pass passes[2][4];
    std::vector<float> pre;
    int preLength = 1;
    int preAt = 0;
    float gain = 0;
};

/// The echo: a delay that comes back fully wet, rolled off above 12 kHz each time round. A new
/// time crossfades from the old one in 20 ms rather than sliding the pitch.
class Echo {
public:
    void init(double sampleRate) {
        rate = sampleRate;
        size = int(2.1 * sampleRate) + 4;
        line[0].assign(size_t(size), 0);
        line[1].assign(size_t(size), 0);
        roll = float(1 - std::exp(-kTwoPi * 12000 / sampleRate));
        swapLength = std::max(1, int(0.02 * sampleRate));
        ease = smoothing(sampleRate, 10);
        time = wantTime = 0.36 * sampleRate;
    }

    void set(double seconds, float feedbackPercent) {
        wantTime = clampTo(seconds, 0.01, 2.0) * rate;
        wantFeedback = clampTo(feedbackPercent, 0.0f, 95.0f) / 100;
    }

    void run(float inL, float inR, float &outL, float &outR) {
        if (swapLeft == 0 && wantTime != time) {
            fromTime = time;
            time = wantTime;
            swapLeft = swapLength;
        }
        float l = tap(0, time);
        float r = tap(1, time);
        if (swapLeft > 0) {
            const float old = float(swapLeft) / float(swapLength);
            l = l * (1 - old) + tap(0, fromTime) * old;
            r = r * (1 - old) + tap(1, fromTime) * old;
            --swapLeft;
        }
        held[0] += roll * (l - held[0]);
        held[1] += roll * (r - held[1]);
        feedback += ease * (wantFeedback - feedback);
        line[0][size_t(write)] = inL + held[0] * feedback;
        line[1][size_t(write)] = inR + held[1] * feedback;
        if (++write >= size) write = 0;
        outL = held[0];
        outR = held[1];
    }

private:
    float tap(int c, double delay) {
        double at = write - delay;
        while (at < 0) at += size;
        const int i = int(at);
        const float f = float(at - i);
        const int j = i + 1 >= size ? 0 : i + 1;
        return line[c][size_t(i)] * (1 - f) + line[c][size_t(j)] * f;
    }

    double rate = 48000;
    std::vector<float> line[2];
    int size = 1;
    int write = 0;
    double time = 1;
    double wantTime = 1;
    double fromTime = 1;
    int swapLeft = 0;
    int swapLength = 1;
    float feedback = 0;
    float wantFeedback = 0;
    float held[2] = {0, 0};
    float roll = 1;
    float ease = 1;
};

bool operator==(const SlabHold &a, const SlabHold &b) {
    return a.pitchOffset == b.pitchOffset && a.lowpassCap == b.lowpassCap && a.gainBoost == b.gainBoost &&
           a.echoMix == b.echoMix && a.echoFeedback == b.echoFeedback && a.echoTime == b.echoTime;
}
bool operator!=(const SlabHold &a, const SlabHold &b) { return !(a == b); }

SlabMood neutralMood() {
    SlabMood m;
    m.pitch = 0;
    m.reverb = 0;
    m.reverbPreset = SLAB_ROOM_LARGE_HALL_2;
    m.delayTime = 0.36;
    m.delayFeedback = 0;
    m.delayMix = 0;
    m.lowpass = 20000;
    m.gain = 0;
    m.wow = 0;
    return m;
}

SlabHold noHold() {
    SlabHold h;
    h.pitchOffset = 0;
    h.lowpassCap = 20000;
    h.gainBoost = 0;
    h.echoMix = 0;
    h.echoFeedback = 0;
    h.echoTime = 0.36;
    return h;
}

}  // namespace

struct SlabSound {
    using Stretch = signalsmith::stretch::SignalsmithStretch<float>;

    static constexpr int kStep = 64;
    static constexpr int kMaxHolds = 8;
    static constexpr double kHoldLifetime = 10;
    static constexpr double kCatchUp = 1.04;
    static constexpr double kTapeFloor = 0.03125;

    const double rate;
    const int fade;
    Stretch stretch;
    Room room;
    Echo echo;
    LowPass lowPass;

    // Settings waiting for the audio thread.
    std::mutex mail;
    bool moodWaiting = false;
    SlabMood moodMail = neutralMood();
    struct HoldOrder {
        SlabHold hold;
        int ms;
    };
    HoldOrder holdMail[kMaxHolds];
    int holdMailCount = 0;
    bool tapeWaiting = false;
    int tapeMail[3] = {0, 0, 0};
    std::atomic<int> holdingNow{0};

    // Everything below is the audio thread's.
    long long clock = 0;
    SlabMood mood = neutralMood();
    SlabHold holdNow = noHold();
    SlabHold holdFrom = noHold();
    SlabHold holdTo = noHold();
    long long holdStart = 0;
    long long holdFrames = 0;
    long long holdRefreshed = 0;
    bool holdRamping = false;
    double ringTime = 0.36;
    float ringFeedback = 0;
    long long ringUntil = -1;
    bool ringPending = false;

    float wowDepth = 0;
    long long wowStart = 0;
    bool tapeOn = false;
    long long tapeStart = 0;
    long long tapeDown = 0, tapeHold = 0, tapeUp = 0;
    long long tapeUntil = -1;

    int blockOut = 0;
    int blockIn = 0;
    double blockRate = 1;
    double credit = 0;
    double cents = 0;
    double appliedCents = 1e9;

    int roomPreset = SLAB_ROOM_LARGE_HALL_2;
    int roomWanted = SLAB_ROOM_LARGE_HALL_2;
    float roomMix = 0, roomMixWanted = 0;
    float roomLevel = 1;
    float sendLevel = 0, sendWanted = 0;
    float trim = 1, trimWanted = 1;
    float cutoff = 20000;
    bool filterOn = false;
    float filterMix = 0;
    float ease = 1;
    float roomEase = 1;
    float filterEase = 1;

    // A cut's crossfade: what the stretcher made of the old sound past the cut, fading out.
    std::vector<float> tail[2];
    std::vector<float> nextTail[2];
    int tailLeft = 0;
    std::vector<float> fadeIn, fadeOut;
    std::vector<float> silence;

    SlabSound(double sampleRate, double blockMs, double intervalMs, int fadeFrames)
        : rate(sampleRate), fade(std::max(16, fadeFrames)) {
        const int block = std::max(256, int(sampleRate * blockMs / 1000));
        const int interval = clampTo(int(sampleRate * intervalMs / 1000), 64, block / 2);
        stretch.configure(2, block, interval);
        room.init(sampleRate);
        echo.init(sampleRate);
        ease = smoothing(sampleRate, 5);
        roomEase = smoothing(sampleRate, 3);
        filterEase = 1.0f / kStep;
        for (int c = 0; c < 2; ++c) {
            tail[c].assign(size_t(fade), 0);
            nextTail[c].assign(size_t(fade), 0);
        }
        fadeIn.resize(size_t(fade) + 1);
        fadeOut.resize(size_t(fade) + 1);
        for (int i = 0; i <= fade; ++i) {
            fadeIn[size_t(i)] = float(std::sin(double(i) / fade * kTwoPi / 4));
            fadeOut[size_t(i)] = float(std::cos(double(i) / fade * kTwoPi / 4));
        }
        // Enough silence to stand in for a missing tail at four times speed.
        silence.assign(size_t(fade) * 4 + 8, 0);
        pushMood(mood);
    }

    int latency() const { return stretch.inputLatency() + stretch.outputLatency(); }

    // MARK: Settings, as the audio thread takes them

    void takeMail() {
        bool gotMood = false, gotTape = false;
        SlabMood m;
        HoldOrder holds[kMaxHolds];
        int holdCount = 0;
        int tape[3] = {0, 0, 0};
        {
            std::lock_guard<std::mutex> lock(mail);
            if (moodWaiting) {
                m = moodMail;
                gotMood = true;
                moodWaiting = false;
            }
            holdCount = holdMailCount;
            for (int i = 0; i < holdCount; ++i) holds[i] = holdMail[i];
            holdMailCount = 0;
            if (tapeWaiting) {
                for (int i = 0; i < 3; ++i) tape[i] = tapeMail[i];
                gotTape = true;
                tapeWaiting = false;
            }
        }
        if (gotMood) pushMood(m);
        for (int i = 0; i < holdCount; ++i) startHold(holds[i].hold, holds[i].ms);
        if (gotTape) startTapeStop(tape[0], tape[1], tape[2]);
    }

    void pushMood(const SlabMood &m) {
        mood = m;
        roomWanted = clampTo(m.reverbPreset, 0, SLAB_ROOM_COUNT - 1);
        // Nothing of the room is heard: change its character on the spot.
        if (roomWanted != roomPreset && roomMix < 1e-4f && roomMixWanted < 1e-4f) {
            room.tune(roomWanted);
            roomPreset = roomWanted;
        }
        roomMixWanted = clampTo(m.reverb, 0.0f, 100.0f) / 100;
        setWow(m.wow);
        mix();
    }

    void setWow(float amount) {
        const bool wasOn = wowDepth > 0;
        wowDepth = clampTo(amount, 0.0f, 1.0f);
        if (wowDepth > 0 && !wasOn) wowStart = clock;
    }

    /// The tape's speed under wow: a fraction of a percent, slow and never quite the same twice.
    double wowSpeed(long long at) const {
        if (wowDepth <= 0) return 1;
        const double t = double(at - wowStart) / rate;
        const double wander = 0.78 * std::sin(kTwoPi * 0.62 * t) + 0.22 * std::sin(kTwoPi * 1.73 * t + 1.1);
        return 1 + 0.0028 * wowDepth * wander;
    }

    /// The parts a hold moves, as the mood sets them with the hold on top.
    void mix() {
        cents = clampTo(double(mood.pitch) + holdNow.pitchOffset, -2400.0, 2400.0);
        // While a thrown echo rings out it keeps its own time and feedback; only the send was cut.
        const bool echoing = holdNow.echoMix > 0;
        const bool ringing = !echoing && clock < ringUntil;
        const double time = echoing ? holdNow.echoTime : ringing ? ringTime : mood.delayTime;
        const float feedback = echoing ? std::max(mood.delayFeedback, holdNow.echoFeedback)
                               : ringing ? ringFeedback
                                         : mood.delayFeedback;
        echo.set(time, feedback);
        sendWanted = clampTo(std::max(mood.delayMix, holdNow.echoMix) / 100, 0.0f, 1.0f);
        const float wanted = clampTo(std::min(mood.lowpass, holdNow.lowpassCap), 200.0f, 20000.0f);
        filterOn = wanted < 19900;
        if (filterOn && wanted != cutoff) lowPass.set(rate, wanted);
        cutoff = wanted;
        trimWanted = float(std::pow(10.0, clampTo(double(mood.gain) + holdNow.gainBoost, -24.0, 12.0) / 20));
    }

    void startHold(const SlabHold &target, int ms) {
        // The same hold again is SLAB saying it's still down: keep it, and whatever ramp it's on.
        if (target == holdTo && target != noHold()) {
            holdRefreshed = clock;
            return;
        }
        holdFrom = holdNow;
        holdTo = target;
        if (target.echoMix > 0) {
            // An echo coming in takes its time and feedback at once and only its level ramps.
            holdFrom.echoTime = target.echoTime;
            holdFrom.echoFeedback = target.echoFeedback;
        } else if (holdFrom.echoMix > 0) {
            // Let go: the send is cut and what's in the echo rings out, until it's under -60 dB.
            const double feedback = std::max(0.05, double(holdFrom.echoFeedback) / 100);
            const double seconds = std::min(8.0, std::max(1.0, holdFrom.echoTime * std::log(0.001) / std::log(feedback)));
            ringTime = holdFrom.echoTime;
            ringFeedback = holdFrom.echoFeedback;
            ringUntil = clock + (long long)(seconds * rate);
            ringPending = true;
        }
        holdStart = clock;
        holdFrames = (long long)(std::max(0, ms) * rate / 1000);
        holdRamping = true;
        holdRefreshed = clock;
        stepHold();
    }

    void stepHold() {
        const double t = holdFrames > 0 ? std::min(1.0, double(clock - holdStart) / double(holdFrames)) : 1;
        const float s = float(t);
        SlabHold h = noHold();
        h.pitchOffset = holdFrom.pitchOffset + (holdTo.pitchOffset - holdFrom.pitchOffset) * s;
        // The filter sweeps evenly to the ear: in octaves, not hertz.
        h.lowpassCap = holdFrom.lowpassCap * std::pow(holdTo.lowpassCap / holdFrom.lowpassCap, s);
        h.gainBoost = holdFrom.gainBoost + (holdTo.gainBoost - holdFrom.gainBoost) * s;
        h.echoMix = holdFrom.echoMix + (holdTo.echoMix - holdFrom.echoMix) * s;
        // Going out, the echo keeps its time and feedback until it has faded away.
        const SlabHold &echoing = t < 1 && holdTo.echoMix == 0 ? holdFrom : holdTo;
        h.echoTime = echoing.echoTime;
        h.echoFeedback = echoing.echoFeedback;
        holdNow = t >= 1 ? holdTo : h;
        if (t >= 1) holdRamping = false;
        mix();
    }

    void startTapeStop(int downMs, int holdMs, int upMs) {
        tapeOn = true;
        tapeStart = clock;
        tapeDown = (long long)(std::max(80, downMs) * rate / 1000);
        tapeHold = (long long)(std::max(0, holdMs) * rate / 1000);
        tapeUp = (long long)(std::max(80, upMs) * rate / 1000);
        tapeUntil = clock + tapeDown + tapeHold + tapeUp + (long long)(0.05 * rate);
    }

    /// The tape stop's speed: down to almost nothing on a curve, held there, then wound back up.
    double tapeSpeed() {
        const long long t = clock - tapeStart;
        if (t < tapeDown) return 1 - (1 - kTapeFloor) * std::pow(double(t) / double(tapeDown), 2.2);
        if (t < tapeDown + tapeHold) return kTapeFloor;
        if (t < tapeDown + tapeHold + tapeUp) {
            const double x = double(t - tapeDown - tapeHold) / double(tapeUp);
            return kTapeFloor + (1 - kTapeFloor) * (1 - std::pow(1 - x, 2.2));
        }
        tapeOn = false;
        return 1;
    }

    /// Per step of 64 frames: ramps, a hold left unrefreshed, a thrown echo done ringing, and the pitch.
    void control() {
        if (holdRamping) stepHold();
        if (holdTo != noHold() && clock - holdRefreshed > (long long)(kHoldLifetime * rate)) startHold(noHold(), 300);
        if (ringPending && clock >= ringUntil) {
            ringPending = false;
            mix();
        }
        // Wow moves pitch and time together, as a tape's speed does.
        const double wanted = cents + (wowDepth > 0 ? 1200 * std::log2(wowSpeed(clock)) : 0);
        if (wanted != appliedCents) {
            stretch.setTransposeFactor(float(std::pow(2.0, wanted / 1200)));
            appliedCents = wanted;
        }
        holdingNow.store(holdNow != noHold() || holdTo != noHold() ? 1 : 0, std::memory_order_relaxed);
    }

    // MARK: A block

    int begin(int outputFrames, bool catchingUp) {
        takeMail();
        blockOut = std::max(0, outputFrames);
        // A tape stop has the speed while it runs, and a moment after; otherwise the deck's catch-up.
        double speed = tapeOn ? tapeSpeed() : (catchingUp && clock >= tapeUntil ? kCatchUp : 1);
        speed *= wowSpeed(clock);
        blockRate = speed;
        credit += blockOut * speed;
        blockIn = int(std::floor(credit));
        credit -= blockIn;
        return blockIn;
    }

    int tailFrames() const { return int(std::ceil(fade * blockRate)) + 1; }
    int rollFrames() const { return stretch.outputSeekLength(float(blockRate)); }

    void render(const float *inL, const float *inR, const SlabCut *cuts, int cutCount, float *outL, float *outR) {
        int i0 = 0, o0 = 0;
        for (int k = 0; k <= cutCount; ++k) {
            const bool last = k == cutCount;
            const int i1 = last ? blockIn : clampTo(cuts[k].frame, i0, blockIn);
            int o1 = last || blockIn == 0 ? blockOut : int(std::lround(double(i1) * blockOut / blockIn));
            o1 = clampTo(o1, o0, blockOut);
            play(inL + i0, inR + i0, i1 - i0, outL + o0, outR + o0, o1 - o0);
            if (!last) cut(cuts[k]);
            i0 = i1;
            o0 = o1;
        }
    }

    void play(const float *inL, const float *inR, int frames, float *outL, float *outR, int count) {
        if (count == 0) {
            // A cut on the block's first frame can leave some input with no output of its own.
            if (frames > 0) {
                Input in{{inL, inR}};
                Output out{{outL, outR}};
                stretch.process(in, frames, out, 0);
            }
            return;
        }
        int done = 0, used = 0;
        while (done < count) {
            const int step = std::min(kStep, count - done);
            const int nextUsed = done + step == count ? frames : int(std::lround(double(frames) * (done + step) / count));
            control();
            Input in{{inL + used, inR + used}};
            Output out{{outL + done, outR + done}};
            stretch.process(in, nextUsed - used, out, step);
            after(outL + done, outR + done, step);
            clock += step;
            done += step;
            used = nextUsed;
        }
    }

    /// The old sound played out under the new one: the stretcher carries on with the old sound for
    /// the crossfade, then starts again on the new one, aligned to its first frame.
    void cut(const SlabCut &c) {
        const int need = tailFrames();
        const bool hasTail = c.tailLeft && c.tailRight;
        Input tailIn{{hasTail ? c.tailLeft : silence.data(), hasTail ? c.tailRight : silence.data()}};
        Output tailOut{{nextTail[0].data(), nextTail[1].data()}};
        stretch.process(tailIn, std::min(need, hasTail ? need : int(silence.size())), tailOut, fade);
        // A cut inside the last one's crossfade: what was still fading goes on fading inside this one.
        if (tailLeft > 0) {
            const int from = fade - tailLeft;
            for (int j = 0; j < tailLeft; ++j) {
                const float in = fadeIn[size_t(from + j)];
                const float out = fadeOut[size_t(from + j)];
                for (int c2 = 0; c2 < 2; ++c2) {
                    nextTail[c2][size_t(j)] = nextTail[c2][size_t(j)] * in + tail[c2][size_t(from + j)] * out;
                }
            }
        }
        std::swap(tail[0], nextTail[0]);
        std::swap(tail[1], nextTail[1]);
        tailLeft = fade;
        Input roll{{c.rollLeft, c.rollRight}};
        if (c.rollLeft && c.rollRight) {
            stretch.outputSeek(roll, rollFrames());
        } else {
            stretch.reset();
        }
        // The stretcher starts afresh, so its pitch is set again before the next frame.
        appliedCents = 1e9;
    }

    /// After the stretcher: a cut's crossfade, the low-pass, the room, the echo send, the trim.
    void after(float *l, float *r, int count) {
        for (int i = 0; i < count; ++i) {
            float x = l[i], y = r[i];
            if (tailLeft > 0) {
                const int j = fade - tailLeft;
                x = x * fadeIn[size_t(j)] + tail[0][size_t(j)] * fadeOut[size_t(j)];
                y = y * fadeIn[size_t(j)] + tail[1][size_t(j)] * fadeOut[size_t(j)];
                --tailLeft;
            }

            // Into and out of the low-pass over a step, so turning it on or off never clicks.
            const float filterWanted = filterOn ? 1.0f : 0.0f;
            if (filterMix != filterWanted) {
                filterMix = filterWanted > filterMix ? std::min(1.0f, filterMix + filterEase) : std::max(0.0f, filterMix - filterEase);
                if (filterMix == 0) lowPass.clear();
            }
            if (filterMix > 0) {
                const float fx = lowPass.run(0, x);
                const float fy = lowPass.run(1, y);
                x += (fx - x) * filterMix;
                y += (fy - y) * filterMix;
            }

            // A new room character: what's ringing fades in a few ms, then the new room starts.
            if (roomWanted != roomPreset) {
                roomLevel -= roomEase;
                if (roomLevel <= 0) {
                    roomLevel = 0;
                    room.tune(roomWanted);
                    roomPreset = roomWanted;
                }
            } else if (roomLevel < 1) {
                roomLevel = std::min(1.0f, roomLevel + roomEase);
            }
            roomMix += ease * (roomMixWanted - roomMix);
            float wl, wr;
            room.run(x, y, wl, wr);
            const float wet = roomMix * roomLevel;
            x = x * (1 - roomMix) + wl * wet;
            y = y * (1 - roomMix) + wr * wet;

            // The echo is a send: what goes in is the send's level, and it comes back on top.
            sendLevel += ease * (sendWanted - sendLevel);
            float el, er;
            echo.run(x * sendLevel, y * sendLevel, el, er);
            x += el;
            y += er;

            trim += ease * (trimWanted - trim);
            l[i] = x * trim;
            r[i] = y * trim;
        }
    }
};

extern "C" {

SlabSound *slab_sound_create(double sampleRate, double blockMs, double intervalMs, int fadeFrames) {
    if (!(sampleRate > 0)) return nullptr;
    return new SlabSound(sampleRate, blockMs, intervalMs, fadeFrames);
}

void slab_sound_destroy(SlabSound *sound) { delete sound; }

void slab_sound_set_mood(SlabSound *sound, SlabMood mood) {
    std::lock_guard<std::mutex> lock(sound->mail);
    sound->moodMail = mood;
    sound->moodWaiting = true;
}

void slab_sound_hold(SlabSound *sound, SlabHold hold, int ms) {
    std::lock_guard<std::mutex> lock(sound->mail);
    if (sound->holdMailCount == SlabSound::kMaxHolds) {
        // A burst nothing has rendered yet: the oldest goes, the newest stands.
        std::copy(sound->holdMail + 1, sound->holdMail + SlabSound::kMaxHolds, sound->holdMail);
        sound->holdMailCount -= 1;
    }
    sound->holdMail[sound->holdMailCount++] = {hold, ms};
    // Seen as held at once, before the audio thread has taken it.
    if (hold != noHold()) sound->holdingNow.store(1, std::memory_order_relaxed);
}

void slab_sound_tape_stop(SlabSound *sound, int downMs, int holdMs, int upMs) {
    std::lock_guard<std::mutex> lock(sound->mail);
    sound->tapeMail[0] = downMs;
    sound->tapeMail[1] = holdMs;
    sound->tapeMail[2] = upMs;
    sound->tapeWaiting = true;
}

int slab_sound_holding(SlabSound *sound) { return sound->holdingNow.load(std::memory_order_relaxed); }

int slab_sound_latency(const SlabSound *sound) { return sound->latency(); }

SlabMood slab_sound_neutral_mood(void) { return neutralMood(); }

SlabHold slab_sound_no_hold(void) { return noHold(); }

int slab_sound_begin(SlabSound *sound, int outputFrames, int catchingUp) {
    return sound->begin(outputFrames, catchingUp != 0);
}

int slab_sound_tail_frames(const SlabSound *sound) { return sound->tailFrames(); }

int slab_sound_roll_frames(const SlabSound *sound) { return sound->rollFrames(); }

void slab_sound_render(SlabSound *sound, const float *inLeft, const float *inRight,
                       const SlabCut *cuts, int cutCount, float *outLeft, float *outRight) {
    sound->render(inLeft, inRight, cuts, std::max(0, cutCount), outLeft, outRight);
}

}  // extern "C"
