import Foundation
import Network

/// Tiny HTTP control surface on 127.0.0.1 so the Spicetify extension can drive the DSP.
final class ControlServer {
    private let listener: NWListener
    private let port: UInt16
    private var graph: DSPGraph?
    private var statusProvider: () -> [String: Any]

    init(port: UInt16, statusProvider: @escaping () -> [String: Any]) throws {
        self.port = port
        self.statusProvider = statusProvider
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: params)
    }

    func attach(graph: DSPGraph) {
        self.graph = graph
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.start(queue: .global(qos: .userInitiated))
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
            if error != nil { connection.cancel(); return }

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

    private struct Request {
        let method: String
        let path: String
        let body: Data
    }

    private static func parse(_ data: Data) -> Request? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerText = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self)
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }

        var contentLength = 0
        for line in lines.dropFirst() {
            let lower = line.lowercased()
            if lower.hasPrefix("content-length:") {
                contentLength = Int(line.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let bodyStart = headerEnd.upperBound
        guard data.count - bodyStart >= contentLength else { return nil }
        let body = data.subdata(in: bodyStart..<(bodyStart + contentLength))
        return Request(method: String(parts[0]), path: String(parts[1]), body: body)
    }

    private func respond(_ request: Request, on connection: NWConnection) {
        let (status, payload) = route(request)
        let body = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{}".utf8)
        var header = "HTTP/1.1 \(status) OK\r\n"
        header += "Content-Type: application/json\r\n"
        header += "Content-Length: \(body.count)\r\n"
        header += "Access-Control-Allow-Origin: *\r\n"
        header += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        header += "Access-Control-Allow-Headers: Content-Type\r\n"
        header += "Access-Control-Allow-Private-Network: true\r\n"
        header += "Cache-Control: no-store\r\n"
        header += "Connection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func route(_ request: Request) -> (Int, [String: Any]) {
        if request.method == "OPTIONS" { return (204, [:]) }
        let path = request.path.split(separator: "?").first.map(String.init) ?? request.path

        switch (request.method, path) {
        case ("GET", "/status"):
            var payload = statusProvider()
            if let graph {
                payload["running"] = graph.isRunning
                payload["latencyMs"] = (graph.latencyMs * 10).rounded() / 10
                payload["droppedFrames"] = graph.droppedFrames
                let p = graph.current
                payload["params"] = [
                    "pitch": p.pitch, "reverb": p.reverb, "reverbPreset": p.reverbPreset,
                    "delayTime": p.delayTime, "delayFeedback": p.delayFeedback,
                    "delayMix": p.delayMix, "lowpass": p.lowpass, "gain": p.gain,
                ] as [String: Any]
            }
            return (200, payload)

        case ("POST", "/params"):
            guard let graph else { return (503, ["ok": false, "error": "graph not ready"]) }
            guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] else {
                return (400, ["ok": false, "error": "bad json"])
            }
            var p = graph.current
            if let v = object["pitch"] as? NSNumber { p.pitch = v.floatValue }
            if let v = object["reverb"] as? NSNumber { p.reverb = v.floatValue }
            if let v = object["reverbPreset"] as? String { p.reverbPreset = v }
            if let v = object["delayTime"] as? NSNumber { p.delayTime = v.doubleValue }
            if let v = object["delayFeedback"] as? NSNumber { p.delayFeedback = v.floatValue }
            if let v = object["delayMix"] as? NSNumber { p.delayMix = v.floatValue }
            if let v = object["lowpass"] as? NSNumber { p.lowpass = v.floatValue }
            if let v = object["gain"] as? NSNumber { p.gain = v.floatValue }
            graph.apply(p)
            return (200, ["ok": true, "params": [
                "pitch": p.pitch, "reverb": p.reverb, "reverbPreset": p.reverbPreset,
                "delayTime": p.delayTime, "delayFeedback": p.delayFeedback,
                "delayMix": p.delayMix, "lowpass": p.lowpass, "gain": p.gain,
            ]])

        case ("POST", "/tapstop"):
            guard let graph else { return (503, ["ok": false]) }
            let object = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            let down = (object["downMs"] as? NSNumber)?.intValue ?? 420
            let hold = (object["holdMs"] as? NSNumber)?.intValue ?? 90
            let up = (object["upMs"] as? NSNumber)?.intValue ?? 260
            graph.tapeStop(downMs: down, holdMs: hold, upMs: up)
            return (200, ["ok": true])

        case ("POST", "/quit"):
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { exit(0) }
            return (200, ["ok": true, "bye": true])

        case ("POST", "/reset"):
            guard let graph else { return (503, ["ok": false]) }
            graph.apply(.neutral)
            return (200, ["ok": true])

        default:
            return (404, ["ok": false, "error": "not found"])
        }
    }
}
