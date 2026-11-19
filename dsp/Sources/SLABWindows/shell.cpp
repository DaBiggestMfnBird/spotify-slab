// The control port's socket, the tray icon, and Start at Login.
#ifdef _WIN32

#include "slab_windows.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>

#include <atomic>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <vector>

namespace {

std::wstring wide(const char *utf8) {
    if (!utf8) return std::wstring();
    const int n = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring out(size_t(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &out[0], n);
    out.resize(size_t(n - 1));
    return out;
}

}  // namespace

// MARK: The control port

struct SlabServer {
    SOCKET listener = INVALID_SOCKET;
    HANDLE thread = nullptr;
    std::atomic<bool> running{true};
    SlabServe serve = nullptr;
    void *context = nullptr;
};

namespace {

struct Connection {
    SlabServer *server;
    SOCKET socket;
};

/// One connection: read until the whole request is in, answer, close. Requests are a few hundred
/// bytes; one that isn't done in 2 s, or runs past 64 KB, is dropped.
DWORD WINAPI connectionThread(void *p) {
    Connection *c = static_cast<Connection *>(p);
    DWORD timeout = 2000;
    setsockopt(c->socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&timeout), sizeof(timeout));
    std::vector<char> data;
    char chunk[4096];
    for (;;) {
        const int got = recv(c->socket, chunk, int(sizeof(chunk)), 0);
        if (got <= 0) break;
        data.insert(data.end(), chunk, chunk + got);
        if (data.size() > 65536) break;
        char *reply = nullptr;
        const long length = c->server->serve(c->server->context, data.data(), long(data.size()), &reply);
        if (length < 0) continue;
        long sent = 0;
        while (reply && sent < length) {
            const int n = send(c->socket, reply + sent, int(length - sent), 0);
            if (n <= 0) break;
            sent += n;
        }
        std::free(reply);
        break;
    }
    shutdown(c->socket, SD_BOTH);
    closesocket(c->socket);
    delete c;
    return 0;
}

DWORD WINAPI listenThread(void *p) {
    SlabServer *server = static_cast<SlabServer *>(p);
    while (server->running) {
        SOCKET client = accept(server->listener, nullptr, nullptr);
        if (client == INVALID_SOCKET) {
            if (!server->running) break;
            Sleep(50);
            continue;
        }
        HANDLE thread = CreateThread(nullptr, 0, connectionThread, new Connection{server, client}, 0, nullptr);
        if (thread) {
            CloseHandle(thread);
        } else {
            closesocket(client);
        }
    }
    return 0;
}

}  // namespace

SlabServer *slab_serve(int port, SlabServe serve, void *context, long *error) {
    WSADATA wsa;
    int failure = WSAStartup(MAKEWORD(2, 2), &wsa);
    if (failure != 0) {
        if (error) *error = failure;
        return nullptr;
    }
    SlabServer *server = new SlabServer();
    server->serve = serve;
    server->context = context;
    server->listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    // Nobody else may bind the port while SLAB has it, not even with SO_REUSEADDR.
    BOOL exclusive = TRUE;
    sockaddr_in address = {};
    address.sin_family = AF_INET;
    address.sin_port = htons(u_short(port));
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (server->listener == INVALID_SOCKET ||
        setsockopt(server->listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char *>(&exclusive), sizeof(exclusive)) != 0 ||
        bind(server->listener, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) != 0 ||
        listen(server->listener, SOMAXCONN) != 0) {
        if (error) *error = WSAGetLastError();
        if (server->listener != INVALID_SOCKET) closesocket(server->listener);
        delete server;
        WSACleanup();
        return nullptr;
    }
    server->thread = CreateThread(nullptr, 0, listenThread, server, 0, nullptr);
    if (!server->thread) {
        if (error) *error = long(GetLastError());
        closesocket(server->listener);
        delete server;
        WSACleanup();
        return nullptr;
    }
    return server;
}

void slab_serve_stop(SlabServer *server) {
    if (!server) return;
    server->running = false;
    closesocket(server->listener);
    if (WaitForSingleObject(server->thread, 3000) == WAIT_OBJECT_0) {
        CloseHandle(server->thread);
        delete server;
    }
    WSACleanup();
}

// MARK: The tray

namespace {

const UINT kTrayMessage = WM_APP + 1;
const UINT kTrayId = 1;
std::atomic<DWORD> trayThread{0};
SlabTrayStatus trayStatus = nullptr;
SlabTrayAction trayAction = nullptr;
void *trayContext = nullptr;
NOTIFYICONDATAW trayIcon = {};
UINT taskbarCreated = 0;

/// The menu, built fresh each time it opens so its first line is current.
void showMenu(HWND window) {
    HMENU menu = CreatePopupMenu();
    if (!menu) return;
    char status[256] = "SLAB DSP";
    if (trayStatus) trayStatus(trayContext, status, int(sizeof(status)));
    status[sizeof(status) - 1] = 0;
    AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, wide(status).c_str());
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING | (slab_login_item(-1) ? MF_CHECKED : 0), SLAB_TRAY_LOGIN, L"Start at Login");
    AppendMenuW(menu, MF_STRING, SLAB_TRAY_RECONNECT, L"Reconnect to Spotify");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, SLAB_TRAY_QUIT, L"Quit SLAB DSP");
    POINT at;
    GetCursorPos(&at);
    // Without this the menu stays open when the user clicks elsewhere.
    SetForegroundWindow(window);
    const int picked = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, at.x, at.y, 0, window, nullptr);
    PostMessageW(window, WM_NULL, 0, 0);
    DestroyMenu(menu);
    if (picked && trayAction) trayAction(trayContext, picked);
}

LRESULT CALLBACK trayProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == kTrayMessage) {
        const UINT event = LOWORD(lparam);
        if (event == WM_RBUTTONUP || event == WM_LBUTTONUP || event == WM_CONTEXTMENU) showMenu(window);
        return 0;
    }
    // Logging off or shutting down: this process may be gone the moment this returns.
    if (message == WM_ENDSESSION && wparam) {
        if (trayAction) trayAction(trayContext, SLAB_TRAY_ENDING);
        return 0;
    }
    // Explorer restarted, and its notification area with it: put the icon back.
    if (taskbarCreated && message == taskbarCreated) {
        Shell_NotifyIconW(NIM_ADD, &trayIcon);
        return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

/// SLAB's waveform, drawn rather than shipped: five bars, the middle tallest.
HICON makeIcon() {
    const int size = GetSystemMetrics(SM_CXSMICON) > 0 ? GetSystemMetrics(SM_CXSMICON) * 2 : 32;
    BITMAPV5HEADER header = {};
    header.bV5Size = sizeof(header);
    header.bV5Width = size;
    header.bV5Height = -size;
    header.bV5Planes = 1;
    header.bV5BitCount = 32;
    header.bV5Compression = BI_BITFIELDS;
    header.bV5RedMask = 0x00FF0000;
    header.bV5GreenMask = 0x0000FF00;
    header.bV5BlueMask = 0x000000FF;
    header.bV5AlphaMask = 0xFF000000;
    void *bits = nullptr;
    HDC screen = GetDC(nullptr);
    HBITMAP color = CreateDIBSection(screen, reinterpret_cast<BITMAPINFO *>(&header), DIB_RGB_COLORS, &bits, nullptr, 0);
    ReleaseDC(nullptr, screen);
    HBITMAP mask = CreateBitmap(size, size, 1, 1, nullptr);
    if (!color || !mask || !bits) {
        if (color) DeleteObject(color);
        if (mask) DeleteObject(mask);
        return LoadIconW(nullptr, MAKEINTRESOURCEW(32512));
    }
    auto *pixels = static_cast<DWORD *>(bits);
    for (int i = 0; i < size * size; ++i) pixels[i] = 0;
    const double heights[5] = {0.35, 0.65, 0.95, 0.6, 0.3};
    const int bar = size / 9;
    for (int b = 0; b < 5; ++b) {
        const int x0 = bar + b * 2 * bar;
        const int h = int(heights[b] * size * 0.86);
        const int y0 = (size - h) / 2;
        for (int y = y0; y < y0 + h; ++y) {
            for (int x = x0; x < x0 + bar && x < size; ++x) pixels[y * size + x] = 0xFFB36BFF;
        }
    }
    ICONINFO info = {};
    info.fIcon = TRUE;
    info.hbmMask = mask;
    info.hbmColor = color;
    HICON icon = CreateIconIndirect(&info);
    DeleteObject(color);
    DeleteObject(mask);
    return icon ? icon : LoadIconW(nullptr, MAKEINTRESOURCEW(32512));
}

}  // namespace

int slab_tray_run(const char *tip, SlabTrayStatus status, SlabTrayAction action, void *context) {
    trayStatus = status;
    trayAction = action;
    trayContext = context;
    trayThread = GetCurrentThreadId();
    taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");

    WNDCLASSW type = {};
    type.lpfnWndProc = trayProc;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"SLABDSPTray";
    RegisterClassW(&type);
    // A real (hidden) window rather than a message-only one: only top-level windows hear TaskbarCreated.
    HWND window = CreateWindowExW(0, type.lpszClassName, L"SLAB DSP", WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, type.hInstance, nullptr);

    int failed = 1;
    HICON icon = makeIcon();
    if (window) {
        trayIcon.cbSize = sizeof(trayIcon);
        trayIcon.hWnd = window;
        trayIcon.uID = kTrayId;
        trayIcon.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        trayIcon.uCallbackMessage = kTrayMessage;
        trayIcon.hIcon = icon;
        const std::wstring text = wide(tip ? tip : "SLAB DSP");
        wcsncpy_s(trayIcon.szTip, text.c_str(), _TRUNCATE);
        failed = Shell_NotifyIconW(NIM_ADD, &trayIcon) ? 0 : 1;
    }

    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    if (window) {
        Shell_NotifyIconW(NIM_DELETE, &trayIcon);
        DestroyWindow(window);
    }
    if (icon) DestroyIcon(icon);
    trayThread = 0;
    return failed;
}

void slab_tray_quit(void) {
    const DWORD thread = trayThread.load();
    if (thread) PostThreadMessageW(thread, WM_QUIT, 0, 0);
}

// MARK: Start at Login

int slab_login_item(int set) {
    const wchar_t *runKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const wchar_t *name = L"SLAB DSP";
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, runKey, 0, nullptr, 0, KEY_QUERY_VALUE | KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) {
        return 0;
    }
    if (set == 1) {
        wchar_t path[MAX_PATH];
        const DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
        if (n > 0 && n < MAX_PATH) {
            const std::wstring command = L"\"" + std::wstring(path) + L"\"";
            RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE *>(command.c_str()), DWORD((command.size() + 1) * sizeof(wchar_t)));
        }
    } else if (set == 0) {
        RegDeleteValueW(key, name);
    }
    const bool on = RegQueryValueExW(key, name, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS;
    RegCloseKey(key);
    return on ? 1 : 0;
}

#endif  // _WIN32
