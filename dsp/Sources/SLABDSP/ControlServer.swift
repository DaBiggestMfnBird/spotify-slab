import Foundation
import Network

/// Tiny HTTP control surface on 127.0.0.1 so the Spicetify extension can drive the DSP.
final class ControlServer {
    private var listener: NWListener
    private let port: UInt16
    private let supervisor: Supervisor
    private let maxRequestBytes = 65_536

    /// Set by main so `/quit` releases the tap the same way the menu does.
    var onQuit: (() -> Void)?
    var onListeningChange: (() -> Void)?
    private(set) var isListening = false

    init(port: UInt16, supervisor: Supervisor) throws {
        self.port = port
        self.supervisor = supervisor
        listener = try Self.makeListener(port: port)
    }

    private static func makeListener(port: UInt16) throws -> NWListener {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        return try NWListener(using: params)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        // A failed bind is otherwise silent: the helper keeps tapping audio but
        // nothing can reach it, and the extension just says "not running". A
        // restart can race the old process for the port, so keep trying.
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                slabLog("control server listening on 127.0.0.1:\(self.port)")
                self.setListening(true)
            case .failed(let error):
                slabLog("control server failed: \(error) — retrying")
                self.setListening(false)
                self.retry()
            case .waiting(let error):
                slabLog("control server waiting: \(error)")
                self.setListening(false)
            default:
                break
            }
        }
        listener.start(queue: .global(qos: .userInitiated))
    }

    private func setListening(_ value: Bool) {
        guard isListening != value else { return }
        isListening = value
        onListeningChange?()
    }

    private func retry() {
        listener.cancel()
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            if let next = try? Self.makeListener(port: self.port) {
                self.listener = next
                self.start()
            } else {
                self.retry()
            }
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: .global(qos: .userInitiated))
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] chunk, _, isComplete, error in
            guard let self else { return }
            var data = buffer
            if let chunk { data.append(chunk) }
            if error != nil || data.count > self.maxRequestBytes { connection.cancel(); return }

            if let request = Self.parse(data) {
                self.respond(request, on: connection)
                return
            }
            if isComplete {
                connection.cancel()
                return
            }
            self.receive(on: connection, buffer: data)
        }
    }

    /// Origins allowed to drive the helper.
    ///
    /// The desktop client renders extensions inside a webview served from
    /// xpui.app.spotify.com; the open.spotify.com entry covers the web player.
    /// Anything else is refused before routing, so an arbitrary page cannot
    /// repitch your audio or call /quit.
    private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "[::1]"]

    private static let allowedOrigins: Set<String> = [
        "https://xpui.app.spotify.com",
        "https://open.spotify.com",
    ]

    private struct Request {
        let method: String
        let path: String
        let body: Data
        /// Present on every browser-initiated cross-origin call. Absent for
        /// curl and native clients, which are allowed.
        let origin: String?
        /// Without this, DNS rebinding would let a page reach the port as a
        /// same-origin GET, which carries no Origin header at all.
        let host: String?
        /// Set by Chrome's Private Network Access preflight when a public page
        /// asks to reach a loopback address.
        let wantsPrivateNetwork: Bool
    }

    private static func parse(_ data: Data) -> Request? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerText = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self)
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }

        let contentLength = max(0, Int(headers["content-length"] ?? "") ?? 0)
        let bodyStart = headerEnd.upperBound
        guard data.count - bodyStart >= contentLength else { return nil }
        let body = data.subdata(in: bodyStart..<(bodyStart + contentLength))

        return Request(
            method: String(parts[0]),
            path: String(parts[1]),
            body: body,
            origin: headers["origin"],
            host: headers["host"],
            wantsPrivateNetwork: (headers["access-control-request-private-network"] ?? "").lowercased() == "true"
        )
    }

    private func respond(_ request: Request, on connection: NWConnection) {
        // Browser requests carry Origin. A request from somewhere other than
        // Spotify is dropped here, before any route can touch the graph.
        let origin = request.origin
        let hostName = request.host.map { host -> String in
            guard let colon = host.lastIndex(of: ":"), !host.hasSuffix("]") else { return host }
            return String(host[..<colon])
        }
        let hostAllowed = hostName.map { Self.loopbackHosts.contains($0.lowercased()) } ?? true
        let allowed = hostAllowed && (origin.map { Self.allowedOrigins.contains($0) } ?? true)

        let (status, payload): (Int, [String: Any])
        if allowed {
            (status, payload) = route(request)
        } else {
            (status, payload) = (403, ["ok": false, "error": "origin not allowed"])
        }

        let body = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{}".utf8)
        var header = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        header += "Content-Type: application/json\r\n"
        header += "Content-Length: \(body.count)\r\n"
        if let origin, allowed {
            header += "Access-Control-Allow-Origin: \(origin)\r\n"
            header += "Vary: Origin\r\n"
            header += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            header += "Access-Control-Allow-Headers: Content-Type\r\n"
            if request.wantsPrivateNetwork {
                header += "Access-Control-Allow-Private-Network: true\r\n"
            }
        }
        header += "Cache-Control: no-store\r\n"
        header += "Connection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 503: return "Service Unavailable"
        default: return "OK"
        }
    }

    private func status() -> [String: Any] {
        let link = supervisor.link
        let graph = supervisor.graph
        var payload: [String: Any] = [
            "ok": true,
            "service": "slab-dsp",
            "version": slabVersion,
            "process": supervisor.processName,
            "link": link.name,
            "tapping": graph != nil,
            "audio": supervisor.audioFlowing,
            "running": graph?.isRunning ?? false,
            "engine": graph?.isRunning ?? false,
            "level": DSPGraph.renderPeak,
            "params": Self.dictionary(supervisor.currentParams),
        ]
        switch link {
        case .tapping(let pid), .waitingForAudio(let pid): payload["pid"] = pid
        case .failed(let reason): payload["error"] = reason
        case .waitingForProcess: break
        }
        // What this helper can do beyond 0.3.0: SLAB only sends a route to a helper that names it.
        payload["features"] = ["jump", "spin", "hold", "tape", "throw"]
        if let graph {
            payload["latencyMs"] = (graph.latencyMs * 10).rounded() / 10
            payload["droppedFrames"] = graph.droppedFrames
            payload["detached"] = graph.deck.isDetached
            if let gap = graph.deck.seekGapMs { payload["seekGapMs"] = (gap * 10).rounded() / 10 }
            // How chops have gone: jumped, found Spotify again, or gave up waiting and went live.
            payload["chops"] = [
                "jumps": graph.deck.jumps,
                "realigned": graph.deck.realignments,
                "wentLive": graph.deck.fallbacks,
            ]
        }
        if let sampleRate = supervisor.sampleRate { payload["sampleRate"] = sampleRate }
        if let capture = supervisor.capture { payload["callbacks"] = capture.ioCallbacks }
        return payload
    }

    private static func dictionary(_ p: DSPParams) -> [String: Any] {
        [
            "pitch": p.pitch, "reverb": p.reverb, "reverbPreset": p.reverbPreset,
            "delayTime": p.delayTime, "delayFeedback": p.delayFeedback,
            "delayMix": p.delayMix, "lowpass": p.lowpass, "gain": p.gain,
            "wow": p.wow, "hiss": p.hiss, "crackle": p.crackle, "crush": p.crush,
        ]
    }

    private func route(_ request: Request) -> (Int, [String: Any]) {
        if request.method == "OPTIONS" { return (204, [:]) }
        let path = request.path.split(separator: "?").first.map(String.init) ?? request.path

        switch (request.method, path) {
        case ("GET", "/status"):
            return (200, status())

        case ("POST", "/params"):
            guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] else {
                return (400, ["ok": false, "error": "bad json"])
            }
            // Accepted even with nothing tapped: the next tap picks these up.
            var p = supervisor.currentParams
            if let v = object["pitch"] as? NSNumber { p.pitch = v.floatValue }
            if let v = object["reverb"] as? NSNumber { p.reverb = v.floatValue }
            if let v = object["reverbPreset"] as? String { p.reverbPreset = v }
            if let v = object["delayTime"] as? NSNumber { p.delayTime = v.doubleValue }
            if let v = object["delayFeedback"] as? NSNumber { p.delayFeedback = v.floatValue }
            if let v = object["delayMix"] as? NSNumber { p.delayMix = v.floatValue }
            if let v = object["lowpass"] as? NSNumber { p.lowpass = v.floatValue }
            if let v = object["gain"] as? NSNumber { p.gain = v.floatValue }
            if let v = object["wow"] as? NSNumber { p.wow = max(0, min(1, v.floatValue)) }
            if let v = object["hiss"] as? NSNumber { p.hiss = max(0, min(1, v.floatValue)) }
            if let v = object["crackle"] as? NSNumber { p.crackle = max(0, min(1, v.floatValue)) }
            if let v = object["crush"] as? NSNumber { p.crush = max(0, min(1, v.floatValue)) }
            supervisor.apply(p)
            return (200, ["ok": true, "params": Self.dictionary(p)])

        case ("POST", "/tapstop"):
            guard let graph = supervisor.graph else { return (503, ["ok": false, "error": "not tapping"]) }
            let object = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            let down = (object["downMs"] as? NSNumber)?.intValue ?? 420
            let hold = (object["holdMs"] as? NSNumber)?.intValue ?? 90
            let up = (object["upMs"] as? NSNumber)?.intValue ?? 260
            graph.tapeStop(downMs: down, holdMs: hold, upMs: up)
            return (200, ["ok": true])

        case ("POST", "/jump"):
            // A chop, done here so it is instant: the output jumps back in memory now, and SLAB
            // seeks Spotify behind it. Times in ms; seekAheadMs is how far past the jump target
            // SLAB is about to seek Spotify, availableMs how much song SLAB knows is behind it.
            guard let graph = supervisor.graph, let rate = supervisor.sampleRate else {
                return (503, ["ok": false, "error": "not tapping"])
            }
            guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let back = (object["backMs"] as? NSNumber)?.doubleValue else {
                return (400, ["ok": false, "error": "bad json"])
            }
            let frames = { (ms: Double) in Int((ms * rate / 1000).rounded()) }
            let delay = (object["inMs"] as? NSNumber)?.doubleValue ?? 0
            let ahead = (object["seekAheadMs"] as? NSNumber)?.doubleValue ?? 0
            let available = (object["availableMs"] as? NSNumber)?.doubleValue ?? back
            do {
                try graph.deck.scheduleJump(
                    backFrames: frames(back), inFrames: frames(delay),
                    seekAheadFrames: frames(ahead), availableFrames: frames(available)
                )
                return (200, ["ok": true])
            } catch {
                return (409, ["ok": false, "error": "\(error)"])
            }

        case ("POST", "/jump/cancel"):
            // A new track or a pause: a jump still to come is called off, and one waiting on
            // Spotify's audio stops waiting and goes back to live.
            guard let graph = supervisor.graph else { return (503, ["ok": false, "error": "not tapping"]) }
            graph.deck.cancelJump()
            return (200, ["ok": true])

        case ("POST", "/spin"):
            // A backspin into a chop: the record spins back for spinMs, then lands backMs before
            // where the spin began, and SLAB seeks Spotify behind it as for a jump.
            guard let graph = supervisor.graph, let rate = supervisor.sampleRate else {
                return (503, ["ok": false, "error": "not tapping"])
            }
            guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let back = (object["backMs"] as? NSNumber)?.doubleValue,
                  let turn = (object["spinMs"] as? NSNumber)?.doubleValue else {
                return (400, ["ok": false, "error": "bad json"])
            }
            let frames = { (ms: Double) in Int((ms * rate / 1000).rounded()) }
            let ahead = (object["seekAheadMs"] as? NSNumber)?.doubleValue ?? 0
            let available = (object["availableMs"] as? NSNumber)?.doubleValue ?? back
            do {
                try graph.deck.scheduleSpin(
                    backFrames: frames(back), spinFrames: frames(max(100, min(2_000, turn))),
                    seekAheadFrames: frames(ahead), availableFrames: frames(available)
                )
                return (200, ["ok": true])
            } catch {
                return (409, ["ok": false, "error": "\(error)"])
            }

        case ("POST", "/hold"):
            // A pad held on top of the mood, ramped over ms: what it doesn't name is let go.
            // {} lets everything go. Refresh it within 10 s or it lets go by itself.
            guard let graph = supervisor.graph else { return (503, ["ok": false, "error": "not tapping"]) }
            let object = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            var hold = Hold.none
            if let v = object["pitchOffset"] as? NSNumber { hold.pitchOffset = max(-2400, min(2400, v.floatValue)) }
            if let v = object["lowpassCap"] as? NSNumber { hold.lowpassCap = max(200, min(20_000, v.floatValue)) }
            if let v = object["gainBoost"] as? NSNumber { hold.gainBoost = max(-12, min(12, v.floatValue)) }
            if let v = object["echoMix"] as? NSNumber { hold.echoMix = max(0, min(100, v.floatValue)) }
            if let v = object["echoFeedback"] as? NSNumber { hold.echoFeedback = max(0, min(95, v.floatValue)) }
            if let v = object["echoTime"] as? NSNumber { hold.echoTime = max(0.02, min(2, v.doubleValue)) }
            let ms = (object["ms"] as? NSNumber)?.intValue ?? 120
            graph.hold(hold, ms: max(0, min(5_000, ms)))
            return (200, ["ok": true])

        case ("POST", "/quit"):
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [onQuit] in
                if let onQuit { onQuit() } else { exit(0) }
            }
            return (200, ["ok": true, "bye": true])

        case ("POST", "/reset"):
            supervisor.apply(.neutral)
            return (200, ["ok": true])

        case ("POST", "/reconnect"):
            supervisor.reconnect()
            return (200, ["ok": true])

        default:
            return (404, ["ok": false, "error": "not found"])
        }
    }
}
