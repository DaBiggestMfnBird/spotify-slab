import AppKit
import ServiceManagement

/// Menu-bar presence for the helper. `LSUIElement` hides it from the Dock, so
/// without this the only way to see or stop it is Activity Monitor.
final class StatusMenu: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let supervisor: Supervisor
    private let server: ControlServer?
    private let onQuit: () -> Void

    private var statusItem: NSStatusItem?
    private let stateLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let portLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let loginLine = NSMenuItem(title: "Start at Login", action: nil, keyEquivalent: "")

    init(supervisor: Supervisor, server: ControlServer?, onQuit: @escaping () -> Void) {
        self.supervisor = supervisor
        self.server = server
        self.onQuit = onQuit
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "SLAB DSP")
        item.button?.image?.isTemplate = true
        item.menu = buildMenu()
        statusItem = item

        supervisor.onChange = { [weak self] in
            DispatchQueue.main.async { self?.refresh() }
        }
        server?.onListeningChange = { [weak self] in
            DispatchQueue.main.async { self?.refresh() }
        }
        refresh()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false

        let title = NSMenuItem(title: "SLAB DSP \(slabVersion)", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        stateLine.isEnabled = false
        menu.addItem(stateLine)
        portLine.isEnabled = false
        portLine.isHidden = true
        menu.addItem(portLine)
        menu.addItem(.separator())

        menu.addItem(item("Reconnect to \(supervisor.processName)", #selector(reconnect)))
        loginLine.target = self
        loginLine.action = #selector(toggleLogin)
        menu.addItem(loginLine)
        menu.addItem(item("Open Log", #selector(openLog)))
        menu.addItem(.separator())
        menu.addItem(item("Quit SLAB DSP", #selector(quit), key: "q"))
        return menu
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func refresh() {
        stateLine.title = Self.describe(
            supervisor.link,
            flowing: supervisor.audioFlowing,
            pitch: supervisor.currentParams.pitch,
            process: supervisor.processName
        )
        let listening = server?.isListening ?? true
        portLine.isHidden = listening
        portLine.title = "Control port busy — retrying"
        statusItem?.button?.appearsDisabled = !(supervisor.audioFlowing && listening)
        statusItem?.button?.toolTip = stateLine.title

        let status = SMAppService.mainApp.status
        loginLine.state = status == .enabled ? .on : .off
        loginLine.isEnabled = Bundle.main.bundleIdentifier != nil
    }

    private static func describe(_ link: Supervisor.Link, flowing: Bool, pitch: Float, process: String) -> String {
        switch link {
        case .waitingForProcess:
            return "Waiting for \(process) to open"
        case .waitingForAudio:
            return "\(process) is open — play something"
        case .failed(let reason):
            return "Could not attach: \(reason)"
        case .tapping:
            guard flowing else { return "Attached — no audio from \(process) on this Mac" }
            let cents = Int(pitch.rounded())
            if cents == 0 { return "Processing \(process)" }
            return "Processing \(process) · \(cents > 0 ? "+" : "−")\(abs(cents))¢"
        }
    }

    @objc private func reconnect() {
        supervisor.reconnect()
    }

    @objc private func toggleLogin() {
        do {
            try Self.setLoginItem(SMAppService.mainApp.status != .enabled)
        } catch {
            slabLog("login item change failed: \(error)")
        }
        if SMAppService.mainApp.status == .requiresApproval {
            SMAppService.openSystemSettingsLoginItems()
        }
        refresh()
    }

    @objc private func openLog() {
        NSWorkspace.shared.open(slabLogURL)
    }

    @objc private func quit() {
        onQuit()
    }

    static func setLoginItem(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}
