#ifndef SLAB_SOUND_H
#define SLAB_SOUND_H

/// SLAB's sound after the deck, in portable C++: what the Windows helper plays Spotify through,
/// and what the macOS helper's AVAudioEngine graph does, node for node.
///
///   deck -> pitch and tape speed -> low-pass -> room -> echo on a send -> trim
///
/// Pitch and the tape's speed come from a phase-vocoder stretcher (Signalsmith Stretch), which
/// hears 120 ms ahead of what it plays. A cut between two different sounds in what the deck plays
/// (a chop, a spin landing, going back to live) is not fed through it: the old sound is played out
/// over a few milliseconds while the stretcher starts again on the new one, so a chop is heard the
/// moment the deck makes it, with nothing of either sound smeared across it.
///
/// Settings may change from any thread. Rendering belongs to one audio thread, which calls
/// `slab_sound_begin`, reads the frames it asks for from the deck, then calls `slab_sound_render`.

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SlabSound SlabSound;

/// Room characters, as the macOS helper names them.
enum {
    SLAB_ROOM_LARGE_HALL_2 = 0,
    SLAB_ROOM_SMALL_ROOM,
    SLAB_ROOM_MEDIUM_ROOM,
    SLAB_ROOM_LARGE_ROOM,
    SLAB_ROOM_MEDIUM_HALL,
    SLAB_ROOM_LARGE_HALL,
    SLAB_ROOM_PLATE,
    SLAB_ROOM_CATHEDRAL,
    SLAB_ROOM_MEDIUM_CHAMBER,
    SLAB_ROOM_LARGE_CHAMBER,
    SLAB_ROOM_COUNT
};

/// The mood: what SLAB sets and leaves set.
typedef struct SlabMood {
    /// Cents. -1200 is an octave down.
    float pitch;
    /// Room wet/dry, 0...100, and its character (`SLAB_ROOM_*`).
    float reverb;
    int reverbPreset;
    /// The mood's echo: seconds, feedback 0...95, and how much goes into it, 0...100.
    double delayTime;
    float delayFeedback;
    float delayMix;
    /// Low-pass cutoff in Hz. 20000 is open.
    float lowpass;
    /// Output trim in dB.
    float gain;
    /// A worn tape's speed wandering, 0...1.
    float wow;
} SlabMood;

/// A pad held on top of the mood, ramped in and out.
typedef struct SlabHold {
    /// Added to the mood's pitch, in cents.
    float pitchOffset;
    /// The low-pass can't open past this, in Hz. 20000 is no cap.
    float lowpassCap;
    /// Added to the trim, in dB.
    float gainBoost;
    /// An echo over the mood's own: into it 0...100, feedback 0...95, time in seconds.
    float echoMix;
    float echoFeedback;
    double echoTime;
} SlabHold;

/// A cut between two different sounds in what the deck played this block.
typedef struct SlabCut {
    /// The first frame of the new sound among the frames the deck played.
    int frame;
    /// The old sound carrying on past the cut, `slab_sound_tail_frames` of it: it fades out under
    /// the new one. Silence (null) when the old sound had already stopped.
    const float *tailLeft;
    const float *tailRight;
    /// The new sound from where it is heard first, `slab_sound_roll_frames` of it, ending where the
    /// deck's frames from `frame` on begin.
    const float *rollLeft;
    const float *rollRight;
} SlabCut;

/// `blockMs` is the stretcher's window (longer holds the bass together, and is how far ahead it
/// hears), `intervalMs` how often it starts one; `fadeFrames` how long a cut's crossfade is.
SlabSound *slab_sound_create(double sampleRate, double blockMs, double intervalMs, int fadeFrames);
void slab_sound_destroy(SlabSound *sound);

/// Settings, from any thread. They take effect at the start of the next block.
void slab_sound_set_mood(SlabSound *sound, SlabMood mood);
/// Ramps what is held to `hold` over `ms`; a hold of all defaults lets go. The same hold again
/// keeps it down. One nobody refreshes for 10 s lets go by itself.
void slab_sound_hold(SlabSound *sound, SlabHold hold, int ms);
/// The tape slows to almost nothing over `downMs`, stays there `holdMs`, and winds back up over `upMs`.
void slab_sound_tape_stop(SlabSound *sound, int downMs, int holdMs, int upMs);

/// A hold is on, or still letting go.
int slab_sound_holding(SlabSound *sound);
/// How far behind the deck what is heard is, in frames, at normal speed.
int slab_sound_latency(const SlabSound *sound);
/// The settings with nothing set: what `slab_sound_set_mood` and `slab_sound_hold` start from.
SlabMood slab_sound_neutral_mood(void);
SlabHold slab_sound_no_hold(void);

/// Audio thread. Starts a block of `outputFrames` and returns how many frames to read from the deck
/// for it: more while the tape runs fast, fewer while it slows. `catchingUp` is the deck's.
int slab_sound_begin(SlabSound *sound, int outputFrames, int catchingUp);
/// For this block: how much of the old sound a cut needs, and how much of the new one.
int slab_sound_tail_frames(const SlabSound *sound);
int slab_sound_roll_frames(const SlabSound *sound);
/// Renders the block from the frames the deck played and the cuts among them, in order.
void slab_sound_render(SlabSound *sound, const float *inLeft, const float *inRight,
                       const SlabCut *cuts, int cutCount, float *outLeft, float *outRight);

#ifdef __cplusplus
}
#endif

#endif
