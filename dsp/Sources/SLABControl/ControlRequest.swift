import Foundation

/// A request to the control port on 127.0.0.1, as far as the helper reads one.
public struct ControlRequest: Sendable {
    public let method: String
    public let path: String
    public let body: Data
    /// Present on every browser-initiated cross-origin call. Absent for curl and native clients, which are allowed.
    public let origin: String?
    /// Without this, DNS rebinding would let a page reach the port as a same-origin GET, which carries
    /// no Origin header at all.
    public let host: String?
    /// Set by Chrome's Private Network Access preflight when a public page asks to reach a loopback address.
    public let wantsPrivateNetwork: Bool

    /// The most a request may be; a connection that sends more is dropped.
    public static let maxBytes = 65_536

    public init(method: String, path: String, body: Data = Data(), origin: String? = nil, host: String? = nil, wantsPrivateNetwork: Bool = false) {
        self.method = method
        self.path = path
        self.body = body
        self.origin = origin
        self.host = host
        self.wantsPrivateNetwork = wantsPrivateNetwork
    }

    /// The request in `data` once all of it has arrived, headers and body; nil until then.
    public static func parse(_ data: Data) -> ControlRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerText = String(decoding: data[data.startIndex..<headerEnd.lowerBound], as: UTF8.self)
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
        guard data.endIndex - bodyStart >= contentLength else { return nil }
        let body = data.subdata(in: bodyStart..<(bodyStart + contentLength))

        return ControlRequest(
            method: String(parts[0]),
            path: String(parts[1]),
            body: body,
            origin: headers["origin"],
            host: headers["host"],
            wantsPrivateNetwork: (headers["access-control-request-private-network"] ?? "").lowercased() == "true"
        )
    }

    /// The path without its query.
    public var route: String { path.split(separator: "?").first.map(String.init) ?? path }

    /// The body as a JSON object, or nil.
    public var json: [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }

    // MARK: Who may drive the helper

    private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "[::1]"]

    /// The desktop client renders extensions inside a webview served from xpui.app.spotify.com; the
    /// open.spotify.com entry covers the web player.
    private static let allowedOrigins: Set<String> = [
        "https://xpui.app.spotify.com",
        "https://open.spotify.com",
    ]

    /// Sent to this machine by name, and from Spotify or from no page at all. Anything else is refused
    /// before routing, so an arbitrary page can't repitch your audio or call /quit.
    public var isAllowed: Bool {
        let hostName = host.map { host -> String in
            guard let colon = host.lastIndex(of: ":"), !host.hasSuffix("]") else { return host }
            return String(host[..<colon])
        }
        let hostAllowed = hostName.map { Self.loopbackHosts.contains($0.lowercased()) } ?? true
        return hostAllowed && (origin.map { Self.allowedOrigins.contains($0) } ?? true)
    }

    // MARK: The answer

    /// The whole HTTP response to this request: the status line, headers (with CORS for an allowed
    /// origin) and the JSON body. The connection closes after it.
    public func response(_ status: Int, _ payload: [String: Any]) -> Data {
        let body = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{}".utf8)
        var header = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        header += "Content-Type: application/json\r\n"
        header += "Content-Length: \(body.count)\r\n"
        if let origin, isAllowed {
            header += "Access-Control-Allow-Origin: \(origin)\r\n"
            header += "Vary: Origin\r\n"
            header += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            header += "Access-Control-Allow-Headers: Content-Type\r\n"
            if wantsPrivateNetwork {
                header += "Access-Control-Allow-Private-Network: true\r\n"
            }
        }
        header += "Cache-Control: no-store\r\n"
        header += "Connection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(body)
        return out
    }

    static func reason(_ status: Int) -> String {
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
}
