import Foundation
import SLABCore

/// What the control port drives: the helper, on whichever system it runs.
public protocol ControlHelper: AnyObject {
    /// Everything `/status` reports.
    func status() -> [String: Any]
    /// The mood, kept while nothing is tapped so the next tap picks it up.
    var params: DSPParams { get }
    func apply(_ params: DSPParams)
    /// The deck while something is tapped, and the rate it runs at.
    var tapped: (deck: Deck, sampleRate: Double)? { get }
    /// False when nothing is tapped.
    func tapeStop(downMs: Int, holdMs: Int, upMs: Int) -> Bool
    func hold(_ hold: Hold, ms: Int) -> Bool
    func reconnect()
    /// Quits a moment later, once the answer has gone out.
    func quit()
    /// A chop or spin the deck refused, so SLAB falls back to seeking Spotify, the slow way.
    func refused(_ what: String, error: Error, backMs: Double, availableMs: Double)
}

extension ControlHelper {
    public func refused(_ what: String, error: Error, backMs: Double, availableMs: Double) {}
}

/// The control port's routes, the same on every helper: SLAB only sends a route to a helper that
/// names it in `features`.
public enum ControlRoutes {
    public static let features = ["jump", "spin", "hold", "tape", "throw"]

    /// The answer to `request`: 403 for anyone but Spotify, otherwise the route's.
    public static func respond(to request: ControlRequest, helper: ControlHelper) -> Data {
        guard request.isAllowed else { return request.response(403, ["ok": false, "error": "origin not allowed"]) }
        let (status, payload) = route(request, helper: helper)
        return request.response(status, payload)
    }

    public static func route(_ request: ControlRequest, helper: ControlHelper) -> (Int, [String: Any]) {
        if request.method == "OPTIONS" { return (204, [:]) }

        switch (request.method, request.route) {
        case ("GET", "/status"):
            return (200, helper.status())

        case ("POST", "/params"):
            guard let object = request.json else { return (400, ["ok": false, "error": "bad json"]) }
            // Taken even with nothing tapped: the next tap picks it up.
            var p = helper.params
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
            helper.apply(p)
            return (200, ["ok": true, "params": dictionary(p)])

        case ("POST", "/tapstop"):
            let object = request.json ?? [:]
            let down = (object["downMs"] as? NSNumber)?.intValue ?? 420
            let hold = (object["holdMs"] as? NSNumber)?.intValue ?? 90
            let up = (object["upMs"] as? NSNumber)?.intValue ?? 260
            guard helper.tapeStop(downMs: down, holdMs: hold, upMs: up) else { return notTapping }
            return (200, ["ok": true])

        case ("POST", "/jump"):
            // A chop, done in the helper so it is instant: the output jumps back in memory now, and
            // SLAB seeks Spotify behind it. Times in ms; seekAheadMs is how far past the jump target
            // SLAB is about to seek Spotify, availableMs how much song SLAB knows is behind it.
            guard let tapped = helper.tapped else { return notTapping }
            let (deck, rate) = (tapped.deck, tapped.sampleRate)
            guard let object = request.json, let back = (object["backMs"] as? NSNumber)?.doubleValue else {
                return (400, ["ok": false, "error": "bad json"])
            }
            let frames = { (ms: Double) in Int((ms * rate / 1000).rounded()) }
            let delay = (object["inMs"] as? NSNumber)?.doubleValue ?? 0
            let ahead = (object["seekAheadMs"] as? NSNumber)?.doubleValue ?? 0
            let available = (object["availableMs"] as? NSNumber)?.doubleValue ?? back
            do {
                try deck.scheduleJump(
                    backFrames: frames(back), inFrames: frames(delay),
                    seekAheadFrames: frames(ahead), availableFrames: frames(available)
                )
                return (200, ["ok": true])
            } catch {
                helper.refused("chop", error: error, backMs: back, availableMs: available)
                return (409, ["ok": false, "error": "\(error)"])
            }

        case ("POST", "/jump/cancel"):
            // A new track or a pause: a jump still to come is called off, and one waiting on
            // Spotify's audio stops waiting and goes back to live.
            guard let tapped = helper.tapped else { return notTapping }
            tapped.deck.cancelJump()
            return (200, ["ok": true])

        case ("POST", "/spin"):
            // A backspin into a chop: the record spins back for spinMs, then lands backMs before where
            // the spin began, and SLAB seeks Spotify behind it as for a jump.
            guard let tapped = helper.tapped else { return notTapping }
            let (deck, rate) = (tapped.deck, tapped.sampleRate)
            guard let object = request.json,
                  let back = (object["backMs"] as? NSNumber)?.doubleValue,
                  let turn = (object["spinMs"] as? NSNumber)?.doubleValue else {
                return (400, ["ok": false, "error": "bad json"])
            }
            let frames = { (ms: Double) in Int((ms * rate / 1000).rounded()) }
            let ahead = (object["seekAheadMs"] as? NSNumber)?.doubleValue ?? 0
            let available = (object["availableMs"] as? NSNumber)?.doubleValue ?? back
            do {
                try deck.scheduleSpin(
                    backFrames: frames(back), spinFrames: frames(max(100, min(2_000, turn))),
                    seekAheadFrames: frames(ahead), availableFrames: frames(available)
                )
                return (200, ["ok": true])
            } catch {
                helper.refused("spin", error: error, backMs: back, availableMs: available)
                return (409, ["ok": false, "error": "\(error)"])
            }

        case ("POST", "/hold"):
            // A pad held on top of the mood, ramped over ms: what it doesn't name is let go. {} lets
            // everything go. Refresh it within 10 s or it lets go by itself.
            let object = request.json ?? [:]
            var hold = Hold.none
            if let v = object["pitchOffset"] as? NSNumber { hold.pitchOffset = max(-2400, min(2400, v.floatValue)) }
            if let v = object["lowpassCap"] as? NSNumber { hold.lowpassCap = max(200, min(20_000, v.floatValue)) }
            if let v = object["gainBoost"] as? NSNumber { hold.gainBoost = max(-12, min(12, v.floatValue)) }
            if let v = object["echoMix"] as? NSNumber { hold.echoMix = max(0, min(100, v.floatValue)) }
            if let v = object["echoFeedback"] as? NSNumber { hold.echoFeedback = max(0, min(95, v.floatValue)) }
            if let v = object["echoTime"] as? NSNumber { hold.echoTime = max(0.02, min(2, v.doubleValue)) }
            let ms = (object["ms"] as? NSNumber)?.intValue ?? 120
            guard helper.hold(hold, ms: max(0, min(5_000, ms))) else { return notTapping }
            return (200, ["ok": true])

        case ("POST", "/quit"):
            helper.quit()
            return (200, ["ok": true, "bye": true])

        case ("POST", "/reset"):
            helper.apply(.neutral)
            return (200, ["ok": true])

        case ("POST", "/reconnect"):
            helper.reconnect()
            return (200, ["ok": true])

        default:
            return (404, ["ok": false, "error": "not found"])
        }
    }

    private static let notTapping: (Int, [String: Any]) = (503, ["ok": false, "error": "not tapping"])

    public static func dictionary(_ p: DSPParams) -> [String: Any] {
        [
            "pitch": p.pitch, "reverb": p.reverb, "reverbPreset": p.reverbPreset,
            "delayTime": p.delayTime, "delayFeedback": p.delayFeedback,
            "delayMix": p.delayMix, "lowpass": p.lowpass, "gain": p.gain,
            "wow": p.wow, "hiss": p.hiss, "crackle": p.crackle, "crush": p.crush,
        ]
    }

    /// The deck's part of `/status`: whether it plays from memory, what Spotify's seeks cost, and how chops have gone.
    public static func deckStatus(_ deck: Deck) -> [String: Any] {
        var payload: [String: Any] = ["detached": deck.isDetached]
        if let gap = deck.seekGapMs { payload["seekGapMs"] = (gap * 10).rounded() / 10 }
        payload["chops"] = [
            "jumps": deck.jumps,
            "realigned": deck.realignments,
            "wentLive": deck.fallbacks,
        ]
        return payload
    }
}
