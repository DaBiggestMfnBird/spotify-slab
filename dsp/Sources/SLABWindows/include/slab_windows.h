#ifndef SLAB_WINDOWS_H
#define SLAB_WINDOWS_H

/// What the Windows helper needs from Windows itself, behind a plain C interface: hearing Spotify
/// (WASAPI process loopback, Windows 10 2004 / build 19041 and later), playing to the speakers,
/// turning Spotify's own output down while SLAB plays it, the control port's socket, and the tray
/// icon. Everything Swift needs to know of SLAB lives on the Swift side.

#ifdef __cplusplus
extern "C" {
#endif

// MARK: Processes

/// The root of the process tree running `exe` (like "Spotify.exe", any case): one whose parent
/// isn't running `exe` too. 0 when none is running.
unsigned long slab_find_process(const char *exe);

/// Claims this session's single SLAB DSP: 0 when another one already holds it.
int slab_claim_instance(void);

// MARK: Hearing Spotify

typedef struct SlabTap SlabTap;
/// Each packet captured, on the capture thread, as two float channels.
typedef void (*SlabTapSink)(void *context, const float *left, const float *right, int frames);

/// Starts capturing everything process `pid` and its children play, as stereo float at
/// `sampleRate`, each sample multiplied by `gain`. Null on failure, with the HRESULT in `*error`.
SlabTap *slab_tap_start(unsigned long pid, int sampleRate, float gain, SlabTapSink sink, void *context, long *error);
void slab_tap_stop(SlabTap *tap);
/// Packets delivered so far: it moves while Spotify sends audio.
long long slab_tap_packets(SlabTap *tap);
/// Changes the gain, from any thread.
void slab_tap_set_gain(SlabTap *tap, float gain);

// MARK: Playing

typedef struct SlabSpeaker SlabSpeaker;
/// Asked on the render thread for each period: fill `frames` of both channels.
typedef void (*SlabSpeakerSource)(void *context, float *left, float *right, int frames);

/// The default output device's sample rate, or 0 when there is none.
int slab_output_rate(void);

/// Starts playing to the default output device, asking `source` for what to play. `*sampleRate`
/// comes back as the device's rate. Null on failure, with the HRESULT in `*error`.
SlabSpeaker *slab_speaker_start(SlabSpeakerSource source, void *context, int *sampleRate, long *error);
void slab_speaker_stop(SlabSpeaker *speaker);
/// Nonzero once the device has gone (unplugged, or another one made the default): start again.
int slab_speaker_lost(SlabSpeaker *speaker);

// MARK: Spotify's own output

/// Sets the volume of every audio session of process tree `pid`, on every output device. Returns how
/// many sessions it set; `*previous`, when not null, gets the volume the first had, if it differed.
int slab_app_volume(unsigned long pid, float volume, float *previous);

// MARK: The control port

typedef struct SlabServer SlabServer;
/// Asked with everything a connection has sent so far. Either returns -1 for "not all of it yet",
/// or puts a reply made with `malloc` in `*reply` and returns its length; the connection closes after it.
typedef long (*SlabServe)(void *context, const char *data, long length, char **reply);

/// Listens on 127.0.0.1:`port`, each connection served on its own thread. Null when the port can't be
/// had, with the Winsock error in `*error`.
SlabServer *slab_serve(int port, SlabServe serve, void *context, long *error);
void slab_serve_stop(SlabServer *server);

// MARK: The tray

enum {
    SLAB_TRAY_LOGIN = 1,
    SLAB_TRAY_RECONNECT = 2,
    SLAB_TRAY_QUIT = 3,
    /// Windows is logging off or shutting down: whatever must be put back, put back now, on this thread.
    SLAB_TRAY_ENDING = 4,
};

/// What the tray menu's first line says, asked each time the menu opens. Copy at most `size` bytes,
/// UTF-8, into `text`.
typedef void (*SlabTrayStatus)(void *context, char *text, int size);
/// A menu item picked: one of SLAB_TRAY_*.
typedef void (*SlabTrayAction)(void *context, int action);

/// Puts SLAB DSP's icon in the notification area and runs this thread's message loop until
/// `slab_tray_quit`. Returns nonzero if the icon couldn't be added; the loop runs either way.
int slab_tray_run(const char *tip, SlabTrayStatus status, SlabTrayAction action, void *context);
/// Ends `slab_tray_run`'s loop, from any thread.
void slab_tray_quit(void);

/// Start at Login: -1 asks, 0 turns it off, 1 turns it on for this executable. Returns whether it is on.
int slab_login_item(int set);

/// The folder SLAB keeps its log in (%LOCALAPPDATA%\SLAB), created if need be, UTF-8. Empty on failure.
void slab_data_folder(char *path, int size);

#ifdef __cplusplus
}
#endif

#endif
