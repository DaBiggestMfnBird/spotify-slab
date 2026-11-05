import Foundation
#if canImport(Accelerate)
import Accelerate
#endif

/// Finding one stretch of audio inside another.
enum Match {
    /// Where `probe` best matches inside `region` (an offset into `region`) by normalised
    /// cross-correlation, and how well (1 is the same sound). It looks coarsely at an eighth of
    /// the rate first, then measures the most promising places to the sample. Music repeats,
    /// so when several places match equally well it takes the one nearest `expected`, where
    /// the sound ought to be. Nil for silence, or when nothing comes close.
    static func best(probe: [Float], region: [Float], expected: Int) -> (offset: Int, score: Float)? {
        let n = probe.count
        guard n >= 256, region.count >= n else { return nil }
        let factor = 8
        let coarseProbe = decimate(probe, by: factor)
        let coarseRegion = decimate(region, by: factor)
        let m = coarseProbe.count
        guard m > 0, coarseRegion.count >= m else { return nil }

        let probeEnergy = dot(coarseProbe, coarseProbe)
        // Nothing but silence yet: Spotify is still restarting.
        guard probeEnergy > 1e-6 else { return nil }

        let dots = correlate(coarseProbe, in: coarseRegion)
        let candidates = dots.count
        var scores = [Float](repeating: -1, count: candidates)
        var windowEnergy: Float = 0
        for i in 0..<m { windowEnergy += coarseRegion[i] * coarseRegion[i] }
        for k in 0..<candidates {
            if k > 0 {
                let leaving = coarseRegion[k - 1]
                let entering = coarseRegion[k + m - 1]
                windowEnergy = max(0, windowEnergy + entering * entering - leaving * leaving)
            }
            scores[k] = dots[k] / (probeEnergy * max(windowEnergy, 1e-12)).squareRoot()
        }
        // The coarse pass only says where to look; the sample-accurate score decides.
        guard let top = scores.max(), top > 0.35 else { return nil }

        let expectedCoarse = expected / factor
        var peaks: [Int] = []
        for k in 0..<candidates where scores[k] >= top - 0.02 {
            if k > 0, scores[k - 1] > scores[k] { continue }
            if k + 1 < candidates, scores[k + 1] > scores[k] { continue }
            peaks.append(k)
        }
        peaks.sort { abs($0 - expectedCoarse) < abs($1 - expectedCoarse) }

        let fullEnergy = dot(probe, probe)
        var best: (offset: Int, score: Float, distance: Int)?
        region.withUnsafeBufferPointer { r in
            probe.withUnsafeBufferPointer { p in
                guard let regionBase = r.baseAddress, let probeBase = p.baseAddress else { return }
                for peak in peaks.prefix(8) {
                    let centre = peak * factor
                    let lowest = max(0, centre - factor * 2)
                    let highest = min(region.count - n, centre + factor * 2)
                    guard lowest <= highest else { continue }
                    // This place, to the sample.
                    var here: (offset: Int, score: Float)?
                    for offset in lowest...highest {
                        let window = regionBase + offset
                        let energy = dot(window, window, n)
                        let score = dot(probeBase, window, n) / (fullEnergy * max(energy, 1e-12)).squareRoot()
                        if here == nil || score > here!.score { here = (offset, score) }
                    }
                    guard let candidate = here else { continue }
                    let distance = abs(candidate.offset - expected)
                    if let current = best {
                        // Clearly better wins; as good (a repeat of the same bar) goes to the nearer.
                        let better = candidate.score > current.score + 0.005
                            || (candidate.score >= current.score - 0.005 && distance < current.distance)
                        guard better else { continue }
                    }
                    best = (candidate.offset, candidate.score, distance)
                }
            }
        }
        guard let found = best else { return nil }
        return (found.offset, found.score)
    }

    /// How alike two stretches of the same length are: 1 for the same sound at any level, 0 when
    /// either is silent.
    static func similarity(_ a: [Float], _ b: [Float]) -> Float {
        let aa = dot(a, a)
        let bb = dot(b, b)
        guard aa > 1e-9, bb > 1e-9 else { return 0 }
        return dot(a, b) / (aa * bb).squareRoot()
    }

    /// Box-averaged by `factor`: a cheap low-pass and downsample for the coarse search.
    static func decimate(_ samples: [Float], by factor: Int) -> [Float] {
        let count = samples.count / factor
        var out = [Float](repeating: 0, count: count)
        for i in 0..<count {
            var sum: Float = 0
            for j in 0..<factor { sum += samples[i * factor + j] }
            out[i] = sum / Float(factor)
        }
        return out
    }

    /// The dot product of `probe` with every window of `signal` the same length as it.
    static func correlate(_ probe: [Float], in signal: [Float]) -> [Float] {
        let m = probe.count
        let count = signal.count - m + 1
        guard m > 0, count > 0 else { return [] }
        var out = [Float](repeating: 0, count: count)
        signal.withUnsafeBufferPointer { s in
            probe.withUnsafeBufferPointer { p in
                out.withUnsafeMutableBufferPointer { o in
                    guard let sBase = s.baseAddress, let pBase = p.baseAddress, let oBase = o.baseAddress else { return }
                    #if canImport(Accelerate)
                    vDSP_conv(sBase, 1, pBase, 1, oBase, 1, vDSP_Length(count), vDSP_Length(m))
                    #else
                    for k in 0..<count { oBase[k] = dot(pBase, sBase + k, m) }
                    #endif
                }
            }
        }
        return out
    }

    static func dot(_ a: [Float], _ b: [Float]) -> Float {
        let n = min(a.count, b.count)
        guard n > 0 else { return 0 }
        return a.withUnsafeBufferPointer { pa in
            b.withUnsafeBufferPointer { pb in
                guard let aBase = pa.baseAddress, let bBase = pb.baseAddress else { return 0 }
                return dot(aBase, bBase, n)
            }
        }
    }

    static func dot(_ a: UnsafePointer<Float>, _ b: UnsafePointer<Float>, _ n: Int) -> Float {
        #if canImport(Accelerate)
        var result: Float = 0
        vDSP_dotpr(a, 1, b, 1, &result, vDSP_Length(n))
        return result
        #else
        var s0: Float = 0
        var s1: Float = 0
        var s2: Float = 0
        var s3: Float = 0
        var i = 0
        while i + 4 <= n {
            s0 += a[i] * b[i]
            s1 += a[i + 1] * b[i + 1]
            s2 += a[i + 2] * b[i + 2]
            s3 += a[i + 3] * b[i + 3]
            i += 4
        }
        while i < n {
            s0 += a[i] * b[i]
            i += 1
        }
        return (s0 + s1) + (s2 + s3)
        #endif
    }
}
