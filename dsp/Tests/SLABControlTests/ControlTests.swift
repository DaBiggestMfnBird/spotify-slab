import Foundation
import SLABCore
import XCTest
@testable import SLABControl

/// A helper with nothing behind it but a deck: what the routes asked of it.
private final class FakeHelper: ControlHelper {
    var params = DSPParams.neutral
    var tapped: (deck: Deck, sampleRate: Double)?
    var holds: [(hold: Hold, ms: Int)] = []
    var tapeStops: [[Int]] = []
    var refusals: [String] = []
    var quits = 0
    var reconnects = 0

    func status() -> [String: Any] { ["ok": true, "service": "slab-dsp"] }
    func apply(_ params: DSPParams) { self.params = params }

    func tapeStop(downMs: Int, holdMs: Int, upMs: Int) -> Bool {
        guard tapped != nil else { return false }
        tapeStops.append([downMs, holdMs, upMs])
        return true
    }

    func hold(_ hold: Hold, ms: Int) -> Bool {
        guard tapped != nil else { return false }
        holds.append((hold, ms))
        return true
    }

    func reconnect() { reconnects += 1 }
    func quit() { quits += 1 }
    func refused(_ what: String, error: Error, backMs: Double, availableMs: Double) { refusals.append(what) }

    /// A deck that has played two seconds of a tone, as one riding live does.
    func tap() {
        let deck = Deck(sampleRate: 48_000)
        let block = 512
        var written = 0
        let write = { (frames: Int) in
            let samples = (written..<(written + frames)).map { Float(sin(Double($0) * 0.05)) * 0.3 }
            samples.withUnsafeBufferPointer { p in deck.write(p.baseAddress!, p.baseAddress!, frames: frames) }
            written += frames
        }
        write(2_048)
        var out = [Float](repeating: 0, count: block)
        for _ in 0..<(96_000 / block) {
            out.withUnsafeMutableBufferPointer { p in _ = deck.read(into: p.baseAddress!, p.baseAddress!, frames: block) }
            write(block)
        }
        tapped = (deck, 48_000)
    }
}

private let spotify = "https://xpui.app.spotify.com"

private func request(_ method: String, _ path: String, _ json: String = "", origin: String? = spotify,
                     host: String? = "127.0.0.1:47832", privateNetwork: Bool = false) -> ControlRequest {
    ControlRequest(method: method, path: path, body: Data(json.utf8), origin: origin, host: host, wantsPrivateNetwork: privateNetwork)
}

/// The status code and the whole response as text.
private func answer(_ r: ControlRequest, _ helper: FakeHelper) -> (status: Int, text: String) {
    let text = String(decoding: ControlRoutes.respond(to: r, helper: helper), as: UTF8.self)
    let parts = text.split(separator: " ")
    return (parts.count > 1 ? Int(parts[1]) ?? 0 : 0, text)
}

private func body(_ text: String) -> [String: Any] {
    guard let range = text.range(of: "\r\n\r\n") else { return [:] }
    return (try? JSONSerialization.jsonObject(with: Data(text[range.upperBound...].utf8))) as? [String: Any] ?? [:]
}

/// The control port's routes, the same on every helper, checked without a network.
final class ControlTests: XCTestCase {
    // MARK: Reading requests

    func testARequestIsReadOnlyOnceAllOfItHasArrived() throws {
        let json = #"{"pitch":-700}"#
        let head = "POST /params HTTP/1.1\r\nHost: 127.0.0.1:47832\r\nOrigin: \(spotify)\r\nContent-Length: \(json.utf8.count)\r\n\r\n"
        XCTAssertNil(ControlRequest.parse(Data("POST /params HTTP/1.1\r\nHost: 127".utf8)), "headers still coming")
        XCTAssertNil(ControlRequest.parse(Data((head + json.dropLast(5)).utf8)), "body still coming")
        let r = try XCTUnwrap(ControlRequest.parse(Data((head + json).utf8)))
        XCTAssertEqual(r.method, "POST")
        XCTAssertEqual(r.route, "/params")
        XCTAssertEqual(r.origin, spotify)
        XCTAssertEqual(r.host, "127.0.0.1:47832")
        XCTAssertEqual((r.json?["pitch"] as? NSNumber)?.intValue, -700)
    }

    func testAQueryIsNotPartOfTheRoute() throws {
        let r = try XCTUnwrap(ControlRequest.parse(Data("GET /status?t=1 HTTP/1.1\r\n\r\n".utf8)))
        XCTAssertEqual(r.route, "/status")
    }

    // MARK: Who may drive it

    func testSpotifyAndNativeClientsAreLetInAndPagesAreNot() {
        XCTAssertTrue(request("GET", "/status").isAllowed)
        XCTAssertTrue(request("GET", "/status", origin: "https://open.spotify.com").isAllowed)
        XCTAssertTrue(request("GET", "/status", origin: nil).isAllowed, "curl sends no Origin")
        XCTAssertTrue(request("GET", "/status", host: "localhost:47832").isAllowed)
        XCTAssertTrue(request("GET", "/status", host: "[::1]:47832").isAllowed)
        XCTAssertFalse(request("GET", "/status", origin: "https://example.com").isAllowed)
        // DNS rebinding: a page on a name that resolves here, which sends no Origin on a same-origin GET.
        XCTAssertFalse(request("GET", "/status", origin: nil, host: "attacker.example:47832").isAllowed)
    }

    func testAPageIsRefusedBeforeAnyRouteAndGetsNoCORS() {
        let helper = FakeHelper()
        let (status, text) = answer(request("POST", "/quit", origin: "https://example.com"), helper)
        XCTAssertEqual(status, 403)
        XCTAssertEqual(helper.quits, 0)
        XCTAssertFalse(text.contains("Access-Control-Allow-Origin"))
    }

    func testSpotifyGetsCORSAndThePrivateNetworkPreflightAnswered() {
        let helper = FakeHelper()
        let (status, text) = answer(request("OPTIONS", "/params", privateNetwork: true), helper)
        XCTAssertEqual(status, 204)
        XCTAssertTrue(text.contains("Access-Control-Allow-Origin: \(spotify)\r\n"))
        XCTAssertTrue(text.contains("Access-Control-Allow-Private-Network: true\r\n"))
        XCTAssertTrue(text.contains("Connection: close\r\n"))
    }

    // MARK: Routes

    func testStatusIsTheHelpers() {
        let helper = FakeHelper()
        let (status, text) = answer(request("GET", "/status"), helper)
        XCTAssertEqual(status, 200)
        XCTAssertEqual(body(text)["service"] as? String, "slab-dsp")
    }

    func testAMoodIsTakenAndKeptInRangeEvenWithNothingTapped() {
        let helper = FakeHelper()
        let (status, text) = answer(request("POST", "/params", #"{"pitch":-700,"reverbPreset":"largeRoom","wow":3,"crush":-1}"#), helper)
        XCTAssertEqual(status, 200)
        XCTAssertEqual(helper.params.pitch, -700)
        XCTAssertEqual(helper.params.reverbPreset, "largeRoom")
        XCTAssertEqual(helper.params.wow, 1)
        XCTAssertEqual(helper.params.crush, 0)
        let params = body(text)["params"] as? [String: Any]
        XCTAssertEqual((params?["pitch"] as? NSNumber)?.doubleValue, -700)
        XCTAssertEqual(answer(request("POST", "/params", "not json"), helper).status, 400)
        XCTAssertEqual(answer(request("POST", "/reset"), helper).status, 200)
        XCTAssertEqual(helper.params, .neutral)
    }

    func testAHoldIsKeptInRangeAndNeedsSomethingTapped() throws {
        let helper = FakeHelper()
        XCTAssertEqual(answer(request("POST", "/hold", #"{"pitchOffset":-500}"#), helper).status, 503)
        helper.tap()
        XCTAssertEqual(answer(request("POST", "/hold", #"{"pitchOffset":-9000,"lowpassCap":50,"echoMix":38,"ms":99999}"#), helper).status, 200)
        let held = try XCTUnwrap(helper.holds.last)
        XCTAssertEqual(held.hold.pitchOffset, -2400)
        XCTAssertEqual(held.hold.lowpassCap, 200)
        XCTAssertEqual(held.hold.echoMix, 38)
        XCTAssertEqual(held.ms, 5_000)
        // {} lets everything go, over the default ramp.
        XCTAssertEqual(answer(request("POST", "/hold", "{}"), helper).status, 200)
        XCTAssertEqual(helper.holds.last?.hold, Hold.none)
        XCTAssertEqual(helper.holds.last?.ms, 120)
    }

    func testATapeStopTakesTheMacsDefaults() {
        let helper = FakeHelper()
        XCTAssertEqual(answer(request("POST", "/tapstop"), helper).status, 503)
        helper.tap()
        XCTAssertEqual(answer(request("POST", "/tapstop", "{}"), helper).status, 200)
        XCTAssertEqual(helper.tapeStops.last, [420, 90, 260])
        XCTAssertEqual(answer(request("POST", "/tapstop", #"{"downMs":380,"holdMs":70,"upMs":240}"#), helper).status, 200)
        XCTAssertEqual(helper.tapeStops.last, [380, 70, 240])
    }

    func testAChopGoesToTheDeck() throws {
        let helper = FakeHelper()
        XCTAssertEqual(answer(request("POST", "/jump", #"{"backMs":500}"#), helper).status, 503)
        helper.tap()
        let deck = try XCTUnwrap(helper.tapped?.deck)
        XCTAssertEqual(answer(request("POST", "/jump", #"{"inMs":0}"#), helper).status, 400, "no backMs")
        XCTAssertEqual(answer(request("POST", "/jump", #"{"backMs":500,"inMs":0,"seekAheadMs":300,"availableMs":1500}"#), helper).status, 200)
        var out = [Float](repeating: 0, count: 512)
        out.withUnsafeMutableBufferPointer { p in _ = deck.read(into: p.baseAddress!, p.baseAddress!, frames: 512) }
        XCTAssertEqual(deck.jumps, 1)
        XCTAssertTrue(deck.isDetached)
        XCTAssertEqual(answer(request("POST", "/jump/cancel"), helper).status, 200)
        XCTAssertFalse(deck.isDetached, "called off: straight back to live")
    }

    func testAChopFurtherBackThanTheSongRunsIsRefusedAndSaidSo() throws {
        let helper = FakeHelper()
        helper.tap()
        let (status, text) = answer(request("POST", "/jump", #"{"backMs":1500,"availableMs":400}"#), helper)
        XCTAssertEqual(status, 409)
        XCTAssertEqual(body(text)["ok"] as? Bool, false)
        XCTAssertEqual(helper.refusals, ["chop"])
    }

    func testASpinGoesToTheDeck() throws {
        let helper = FakeHelper()
        helper.tap()
        XCTAssertEqual(answer(request("POST", "/spin", #"{"backMs":500}"#), helper).status, 400, "no spinMs")
        XCTAssertEqual(answer(request("POST", "/spin", #"{"backMs":500,"spinMs":300,"availableMs":1500}"#), helper).status, 200)
        XCTAssertEqual(answer(request("POST", "/spin", #"{"backMs":9000,"spinMs":300,"availableMs":1500}"#), helper).status, 409)
        XCTAssertEqual(helper.refusals, ["spin"])
    }

    func testQuitReconnectAndAnythingElse() {
        let helper = FakeHelper()
        let (status, text) = answer(request("POST", "/quit"), helper)
        XCTAssertEqual(status, 200)
        XCTAssertEqual(body(text)["bye"] as? Bool, true)
        XCTAssertEqual(helper.quits, 1)
        XCTAssertEqual(answer(request("POST", "/reconnect"), helper).status, 200)
        XCTAssertEqual(helper.reconnects, 1)
        XCTAssertEqual(answer(request("GET", "/nowhere"), helper).status, 404)
        XCTAssertEqual(answer(request("GET", "/params"), helper).status, 404, "a mood is posted, not fetched")
    }

    func testTheDecksStatusCountsChops() {
        let helper = FakeHelper()
        helper.tap()
        let status = ControlRoutes.deckStatus(helper.tapped!.deck)
        XCTAssertEqual(status["detached"] as? Bool, false)
        let chops = status["chops"] as? [String: Int]
        XCTAssertEqual(chops?["jumps"], 0)
        XCTAssertEqual(chops?["wentLive"], 0)
    }
}
