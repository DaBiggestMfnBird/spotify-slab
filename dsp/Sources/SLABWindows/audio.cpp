// Hearing Spotify and playing what SLAB makes of it, with WASAPI. Each stream runs on its own thread
// with COM to itself, woken by the audio engine, at the "Pro Audio" scheduling class.
#ifdef _WIN32

#include "slab_windows.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>

#include <audioclient.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <tlhelp32.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cwchar>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#if defined(__has_include)
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#define SLAB_HAS_ACTIVATION_PARAMS 1
#endif
#endif

#ifndef SLAB_HAS_ACTIVATION_PARAMS
// Older SDKs (and MinGW) lack the process loopback declarations: these are the Windows SDK's own.
typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum PROCESS_LOOPBACK_MODE {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;
typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
} AUDIOCLIENT_ACTIVATION_PARAMS;
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

namespace {

// The interfaces' IDs, spelled out so nothing hangs on which GUIDs a given SDK's libraries define.
const IID kIUnknown = {0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
const CLSID kMMDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
const IID kIMMDeviceEnumerator = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
const IID kIAudioClient = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
const IID kIAudioCaptureClient = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
const IID kIAudioRenderClient = {0xF294ACFC, 0x3146, 0x4483, {0xA7, 0xBF, 0xAD, 0xDC, 0xA7, 0xC2, 0x60, 0xE2}};
const IID kIAudioSessionManager2 = {0x77AA99A0, 0x1BD6, 0x484F, {0x8B, 0xC7, 0x2C, 0x65, 0x4C, 0x9A, 0x9B, 0x6F}};
const IID kIAudioSessionControl2 = {0xBFB7FF88, 0x7239, 0x4FC9, {0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D}};
const IID kISimpleAudioVolume = {0x87CE5498, 0x68D6, 0x44E5, {0x92, 0x15, 0x6D, 0xA4, 0x7E, 0xF8, 0x83, 0xD8}};
const IID kICompletionHandler = {0x41D949AB, 0x9862, 0x444A, {0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}};
const IID kIAgileObject = {0x94EA2B94, 0xE9CC, 0x49E0, {0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90}};
const GUID kFloatSubtype = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
/// Marks SLAB's own changes to a session's volume, for anything that listens for them.
const GUID kSlabContext = {0x51AB0D5B, 0x7A9E, 0x4C1A, {0x9E, 0x3F, 0x2D, 0x51, 0xAB, 0x00, 0x00, 0x01}};

template <class T>
void release(T *&p) {
    if (p) {
        p->Release();
        p = nullptr;
    }
}

/// COM on this thread for as long as it lives, undone only if this was what started it.
struct Com {
    bool mine;
    Com() : mine(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {}
    ~Com() {
        if (mine) CoUninitialize();
    }
};

/// The audio engine's own priority class for this thread, while it lives.
struct ProAudio {
    HANDLE task = nullptr;
    ProAudio() {
        DWORD index = 0;
        task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &index);
    }
    ~ProAudio() {
        if (task) AvRevertMmThreadCharacteristics(task);
    }
};

WAVEFORMATEXTENSIBLE floatStereo(int sampleRate) {
    WAVEFORMATEXTENSIBLE f = {};
    f.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    f.Format.nChannels = 2;
    f.Format.nSamplesPerSec = DWORD(sampleRate);
    f.Format.wBitsPerSample = 32;
    f.Format.nBlockAlign = 8;
    f.Format.nAvgBytesPerSec = DWORD(sampleRate) * 8;
    f.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    f.Samples.wValidBitsPerSample = 32;
    f.dwChannelMask = SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    f.SubFormat = kFloatSubtype;
    return f;
}

std::wstring wide(const char *utf8) {
    if (!utf8) return std::wstring();
    const int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring out(size_t(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &out[0], n);
    out.resize(size_t(n - 1));
    return out;
}

/// Every running process and its parent.
std::unordered_map<DWORD, DWORD> parents(std::unordered_map<DWORD, std::wstring> *names = nullptr) {
    std::unordered_map<DWORD, DWORD> out;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return out;
    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            out[entry.th32ProcessID] = entry.th32ParentProcessID;
            if (names) (*names)[entry.th32ProcessID] = entry.szExeFile;
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return out;
}

/// `root` and everything it started, and they started.
std::unordered_set<DWORD> tree(DWORD root) {
    const auto up = parents();
    std::unordered_set<DWORD> out{root};
    for (const auto &process : up) {
        DWORD at = process.first;
        // Walk up to the top; a process belongs if `root` is on the way.
        for (int depth = 0; depth < 64 && at != 0; ++depth) {
            if (at == root) {
                out.insert(process.first);
                break;
            }
            const auto parent = up.find(at);
            if (parent == up.end() || parent->second == at) break;
            at = parent->second;
        }
    }
    return out;
}

/// Hands the activated audio client back from whichever thread Windows completes the activation on.
class Activation final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_FAIL;
    IAudioClient *client = nullptr;

    STDMETHODIMP QueryInterface(REFIID riid, void **out) override {
        if (!out) return E_POINTER;
        if (IsEqualIID(riid, kIUnknown) || IsEqualIID(riid, kICompletionHandler)) {
            *out = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
        } else if (IsEqualIID(riid, kIAgileObject)) {
            *out = static_cast<IAgileObject *>(this);
        } else {
            *out = nullptr;
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return ULONG(InterlockedIncrement(&refs)); }
    STDMETHODIMP_(ULONG) Release() override {
        const LONG left = InterlockedDecrement(&refs);
        if (left == 0) delete this;
        return ULONG(left);
    }

    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *operation) override {
        HRESULT hr = E_FAIL;
        IUnknown *unknown = nullptr;
        if (SUCCEEDED(operation->GetActivateResult(&hr, &unknown)) && SUCCEEDED(hr) && unknown) {
            hr = unknown->QueryInterface(kIAudioClient, reinterpret_cast<void **>(&client));
        }
        release(unknown);
        result = hr;
        SetEvent(done);
        return S_OK;
    }

private:
    ~Activation() {
        CloseHandle(done);
        release(client);
    }
    LONG refs = 1;
};

/// A stream's thread: started, told how its start went, stopped and joined.
struct Stream {
    HANDLE thread = nullptr;
    HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    std::atomic<bool> running{true};
    HRESULT started = E_FAIL;

    ~Stream() {
        CloseHandle(ready);
        CloseHandle(wake);
        if (thread) CloseHandle(thread);
    }

    /// Runs `body` on a new thread and waits for it to say how starting went: longer than anything
    /// it waits on itself, so it always has.
    template <class Self>
    HRESULT launch(Self *self, DWORD(WINAPI *body)(void *)) {
        thread = CreateThread(nullptr, 0, body, self, 0, nullptr);
        if (!thread) return HRESULT_FROM_WIN32(GetLastError());
        if (WaitForSingleObject(ready, 15000) != WAIT_OBJECT_0) started = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        return started;
    }

    /// Stops the thread. False if it didn't finish in time: then what it uses must be left alone.
    bool stop() {
        running = false;
        SetEvent(wake);
        return !thread || WaitForSingleObject(thread, 5000) == WAIT_OBJECT_0;
    }

    void say(HRESULT hr) {
        started = hr;
        SetEvent(ready);
    }
};

}  // namespace

// MARK: Processes

unsigned long slab_find_process(const char *exe) {
    const std::wstring want = wide(exe);
    std::unordered_map<DWORD, std::wstring> names;
    const auto up = parents(&names);
    auto runs = [&](DWORD pid) {
        const auto name = names.find(pid);
        return name != names.end() && _wcsicmp(name->second.c_str(), want.c_str()) == 0;
    };
    DWORD best = 0;
    for (const auto &process : names) {
        if (!runs(process.first)) continue;
        const auto parent = up.find(process.first);
        if (parent != up.end() && runs(parent->second)) continue;
        if (best == 0 || process.first < best) best = process.first;
    }
    return best;
}

int slab_claim_instance(void) {
    // Held for as long as this process lives.
    HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\SLAB-DSP");
    if (!mutex) return 1;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(mutex);
        return 0;
    }
    return 1;
}

// MARK: Hearing Spotify

struct SlabTap {
    Stream stream;
    DWORD pid = 0;
    int rate = 48000;
    std::atomic<float> level{1};
    float duck = 1;
    std::atomic<long long> asItCame{0};
    SlabTapSink sink = nullptr;
    void *context = nullptr;
    std::atomic<long long> packets{0};

    /// What this packet is multiplied by: Spotify's level, made up for its sessions being turned
    /// down. A packet that, made up, would pass +6 dBFS can't have been turned down (a session Spotify
    /// has just opened, a slider just moved, or a Windows that captures before the volume): it plays
    /// as it came, at Spotify's level. Decided before any of the packet goes on.
    float gain(const float *in, UINT32 frames) {
        const float wanted = level.load(std::memory_order_relaxed);
        if (duck >= 1) return wanted;
        float peak = 0;
        for (UINT32 i = 0; i < 2 * frames; ++i) peak = std::max(peak, std::fabs(in[i]));
        if (peak * wanted / duck > 2) {
            asItCame.fetch_add(1, std::memory_order_relaxed);
            return wanted;
        }
        return wanted / duck;
    }
};

/// An audio client on everything process `pid` and its children play. Activation is asynchronous
/// even for this: ask, then wait for the handler.
static HRESULT activateLoopback(DWORD pid, IAudioClient **client) {
    Activation *activation = new Activation();
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT prop = {};
    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof(params);
    prop.blob.pBlobData = reinterpret_cast<BYTE *>(&params);
    IActivateAudioInterfaceAsyncOperation *operation = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, kIAudioClient, &prop, activation, &operation);
    if (SUCCEEDED(hr)) {
        hr = WaitForSingleObject(activation->done, 5000) == WAIT_OBJECT_0 ? activation->result : HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    if (SUCCEEDED(hr)) {
        *client = activation->client;
        activation->client = nullptr;
    }
    release(operation);
    activation->Release();
    return hr;
}

static DWORD WINAPI tapThread(void *p) {
    SlabTap *tap = static_cast<SlabTap *>(p);
    Com com;
    IAudioClient *client = nullptr;
    IAudioCaptureClient *capture = nullptr;

    // Float, so the gain that makes up for Spotify being turned down loses nothing: the extensible
    // form first, then the plain one, each on a fresh client, since one that refused a format is spent.
    HRESULT hr = E_FAIL;
    for (int attempt = 0; attempt < 2; ++attempt) {
        release(client);
        hr = activateLoopback(tap->pid, &client);
        if (FAILED(hr)) break;
        WAVEFORMATEXTENSIBLE extensible = floatStereo(tap->rate);
        WAVEFORMATEX plain = extensible.Format;
        plain.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        plain.cbSize = 0;
        hr = client->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            2000000, 0, attempt == 0 ? &extensible.Format : &plain, nullptr);
        if (SUCCEEDED(hr)) break;
    }
    if (SUCCEEDED(hr)) hr = client->GetService(kIAudioCaptureClient, reinterpret_cast<void **>(&capture));
    if (SUCCEEDED(hr)) hr = client->SetEventHandle(tap->stream.wake);
    if (SUCCEEDED(hr)) hr = client->Start();
    tap->stream.say(hr);

    if (SUCCEEDED(hr)) {
        ProAudio priority;
        std::vector<float> left(4096), right(4096);
        while (tap->stream.running) {
            WaitForSingleObject(tap->stream.wake, 100);
            UINT32 next = 0;
            while (tap->stream.running && SUCCEEDED(capture->GetNextPacketSize(&next)) && next > 0) {
                BYTE *data = nullptr;
                UINT32 frames = 0;
                DWORD flags = 0;
                if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
                if (frames > left.size()) {
                    left.resize(frames);
                    right.resize(frames);
                }
                const float *in = reinterpret_cast<const float *>(data);
                const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !in;
                const float gain = silent ? 0 : tap->gain(in, frames);
                for (UINT32 i = 0; i < frames; ++i) {
                    left[i] = silent ? 0 : std::max(-1.0f, std::min(1.0f, in[2 * i] * gain));
                    right[i] = silent ? 0 : std::max(-1.0f, std::min(1.0f, in[2 * i + 1] * gain));
                }
                capture->ReleaseBuffer(frames);
                if (frames > 0) tap->sink(tap->context, left.data(), right.data(), int(frames));
                tap->packets.fetch_add(1, std::memory_order_relaxed);
            }
        }
        client->Stop();
    }
    release(capture);
    release(client);
    return 0;
}

SlabTap *slab_tap_start(unsigned long pid, int sampleRate, float level, float duck, SlabTapSink sink, void *context, long *error) {
    SlabTap *tap = new SlabTap();
    tap->pid = DWORD(pid);
    tap->rate = sampleRate;
    tap->level = std::max(0.0f, std::min(1.0f, level));
    tap->duck = duck > 0 && duck < 1 ? duck : 1;
    tap->sink = sink;
    tap->context = context;
    const HRESULT hr = tap->stream.launch(tap, tapThread);
    if (FAILED(hr)) {
        if (error) *error = long(hr);
        if (tap->stream.stop()) delete tap;
        return nullptr;
    }
    return tap;
}

void slab_tap_stop(SlabTap *tap) {
    if (tap && tap->stream.stop()) delete tap;
}

long long slab_tap_packets(SlabTap *tap) { return tap ? tap->packets.load(std::memory_order_relaxed) : 0; }

void slab_tap_set_level(SlabTap *tap, float level) {
    if (tap) tap->level.store(std::max(0.0f, std::min(1.0f, level)), std::memory_order_relaxed);
}

long long slab_tap_as_it_came(SlabTap *tap) { return tap ? tap->asItCame.load(std::memory_order_relaxed) : 0; }

// MARK: Playing

struct SlabSpeaker {
    Stream stream;
    SlabSpeakerSource source = nullptr;
    void *context = nullptr;
    int rate = 48000;
    std::atomic<int> lost{0};
};

static DWORD WINAPI speakerThread(void *p) {
    SlabSpeaker *speaker = static_cast<SlabSpeaker *>(p);
    Com com;
    IMMDeviceEnumerator *devices = nullptr;
    IMMDevice *device = nullptr;
    IAudioClient *client = nullptr;
    IAudioRenderClient *render = nullptr;
    UINT32 bufferFrames = 0;

    HRESULT hr = CoCreateInstance(kMMDeviceEnumerator, nullptr, CLSCTX_ALL, kIMMDeviceEnumerator, reinterpret_cast<void **>(&devices));
    if (SUCCEEDED(hr)) hr = devices->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (SUCCEEDED(hr)) hr = device->Activate(kIAudioClient, CLSCTX_ALL, nullptr, reinterpret_cast<void **>(&client));
    // Stereo float at the device's own rate: Windows spreads it over however many speakers there are.
    if (SUCCEEDED(hr)) {
        WAVEFORMATEX *mix = nullptr;
        hr = client->GetMixFormat(&mix);
        if (SUCCEEDED(hr)) {
            speaker->rate = int(mix->nSamplesPerSec);
            CoTaskMemFree(mix);
        }
    }
    WAVEFORMATEXTENSIBLE format = floatStereo(speaker->rate);
    if (SUCCEEDED(hr)) {
        hr = client->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            300000, 0, &format.Format, nullptr);
    }
    if (SUCCEEDED(hr)) hr = client->GetBufferSize(&bufferFrames);
    if (SUCCEEDED(hr)) hr = client->GetService(kIAudioRenderClient, reinterpret_cast<void **>(&render));
    if (SUCCEEDED(hr)) hr = client->SetEventHandle(speaker->stream.wake);
    // Silence first, so the device has something before the first wake.
    if (SUCCEEDED(hr)) {
        BYTE *data = nullptr;
        hr = render->GetBuffer(bufferFrames, &data);
        if (SUCCEEDED(hr)) hr = render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
    }
    if (SUCCEEDED(hr)) hr = client->Start();
    speaker->stream.say(hr);

    if (SUCCEEDED(hr)) {
        ProAudio priority;
        std::vector<float> left(bufferFrames), right(bufferFrames);
        while (speaker->stream.running) {
            WaitForSingleObject(speaker->stream.wake, 200);
            if (!speaker->stream.running) break;
            UINT32 padding = 0;
            hr = client->GetCurrentPadding(&padding);
            if (hr == AUDCLNT_E_DEVICE_INVALIDATED) break;
            if (FAILED(hr) || padding >= bufferFrames) continue;
            const UINT32 frames = bufferFrames - padding;
            BYTE *data = nullptr;
            hr = render->GetBuffer(frames, &data);
            if (hr == AUDCLNT_E_DEVICE_INVALIDATED) break;
            if (FAILED(hr)) continue;
            speaker->source(speaker->context, left.data(), right.data(), int(frames));
            float *out = reinterpret_cast<float *>(data);
            for (UINT32 i = 0; i < frames; ++i) {
                out[2 * i] = left[i];
                out[2 * i + 1] = right[i];
            }
            render->ReleaseBuffer(frames, 0);
        }
        if (hr == AUDCLNT_E_DEVICE_INVALIDATED) speaker->lost = 1;
        client->Stop();
    }
    release(render);
    release(client);
    release(device);
    release(devices);
    return 0;
}

int slab_output_rate(void) {
    Com com;
    IMMDeviceEnumerator *devices = nullptr;
    IMMDevice *device = nullptr;
    IAudioClient *client = nullptr;
    WAVEFORMATEX *mix = nullptr;
    int rate = 0;
    if (SUCCEEDED(CoCreateInstance(kMMDeviceEnumerator, nullptr, CLSCTX_ALL, kIMMDeviceEnumerator, reinterpret_cast<void **>(&devices))) &&
        SUCCEEDED(devices->GetDefaultAudioEndpoint(eRender, eConsole, &device)) &&
        SUCCEEDED(device->Activate(kIAudioClient, CLSCTX_ALL, nullptr, reinterpret_cast<void **>(&client))) &&
        SUCCEEDED(client->GetMixFormat(&mix))) {
        rate = int(mix->nSamplesPerSec);
        CoTaskMemFree(mix);
    }
    release(client);
    release(device);
    release(devices);
    return rate;
}

SlabSpeaker *slab_speaker_start(SlabSpeakerSource source, void *context, int *sampleRate, long *error) {
    SlabSpeaker *speaker = new SlabSpeaker();
    speaker->source = source;
    speaker->context = context;
    const HRESULT hr = speaker->stream.launch(speaker, speakerThread);
    if (FAILED(hr)) {
        if (error) *error = long(hr);
        if (speaker->stream.stop()) delete speaker;
        return nullptr;
    }
    if (sampleRate) *sampleRate = speaker->rate;
    return speaker;
}

void slab_speaker_stop(SlabSpeaker *speaker) {
    if (speaker && speaker->stream.stop()) delete speaker;
}

int slab_speaker_lost(SlabSpeaker *speaker) { return speaker ? speaker->lost.load() : 1; }

// MARK: Spotify's own output

int slab_app_volume(unsigned long pid, float volume, float *previous) {
    Com com;
    const std::unordered_set<DWORD> mine = tree(DWORD(pid));
    IMMDeviceEnumerator *devices = nullptr;
    IMMDeviceCollection *outputs = nullptr;
    int set = 0;
    bool first = true;
    HRESULT hr = CoCreateInstance(kMMDeviceEnumerator, nullptr, CLSCTX_ALL, kIMMDeviceEnumerator, reinterpret_cast<void **>(&devices));
    if (SUCCEEDED(hr)) hr = devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &outputs);
    UINT count = 0;
    if (SUCCEEDED(hr)) outputs->GetCount(&count);
    for (UINT d = 0; d < count; ++d) {
        IMMDevice *device = nullptr;
        IAudioSessionManager2 *manager = nullptr;
        IAudioSessionEnumerator *sessions = nullptr;
        int n = 0;
        if (SUCCEEDED(outputs->Item(d, &device)) &&
            SUCCEEDED(device->Activate(kIAudioSessionManager2, CLSCTX_ALL, nullptr, reinterpret_cast<void **>(&manager))) &&
            SUCCEEDED(manager->GetSessionEnumerator(&sessions)) && SUCCEEDED(sessions->GetCount(&n))) {
            for (int i = 0; i < n; ++i) {
                IAudioSessionControl *control = nullptr;
                IAudioSessionControl2 *control2 = nullptr;
                ISimpleAudioVolume *level = nullptr;
                DWORD owner = 0;
                if (SUCCEEDED(sessions->GetSession(i, &control)) &&
                    SUCCEEDED(control->QueryInterface(kIAudioSessionControl2, reinterpret_cast<void **>(&control2))) &&
                    control2->GetProcessId(&owner) == S_OK && mine.count(owner) &&
                    SUCCEEDED(control->QueryInterface(kISimpleAudioVolume, reinterpret_cast<void **>(&level)))) {
                    float was = 1;
                    if (previous && first && SUCCEEDED(level->GetMasterVolume(&was)) && std::fabs(was - volume) > 1e-6f) {
                        *previous = was;
                    }
                    first = false;
                    if (SUCCEEDED(level->SetMasterVolume(volume, &kSlabContext))) ++set;
                }
                release(level);
                release(control2);
                release(control);
            }
        }
        release(sessions);
        release(manager);
        release(device);
    }
    release(outputs);
    release(devices);
    return set;
}

void slab_data_folder(char *path, int size) {
    if (!path || size <= 0) return;
    path[0] = 0;
    wchar_t base[MAX_PATH];
    const DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", base, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return;
    std::wstring folder = std::wstring(base) + L"\\SLAB";
    CreateDirectoryW(folder.c_str(), nullptr);
    if (WideCharToMultiByte(CP_UTF8, 0, folder.c_str(), -1, path, size, nullptr, nullptr) == 0) path[0] = 0;
}

#endif  // _WIN32
