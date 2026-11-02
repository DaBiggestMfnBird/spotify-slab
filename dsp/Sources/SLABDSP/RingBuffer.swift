import Foundation
import os

/// Single-producer / single-consumer stereo float ring buffer.
/// Producer = CoreAudio tap IOProc. Consumer = AVAudioSourceNode render block.
final class StereoRing {
    private let capacity: Int
    private var left: [Float]
    private var right: [Float]
    private var writeIndex = 0
    private var readIndex = 0
    private var available = 0
    private let lock = NSLock()
    /// Hard ceiling on buffered audio. Anything older is dropped so a slow
    /// start or clock drift can never turn into permanent latency.
    private let maxFrames: Int

    init(capacity: Int, maxFrames: Int = 3_072) {
        self.capacity = capacity
        self.maxFrames = min(maxFrames, capacity)
        self.left = [Float](repeating: 0, count: capacity)
        self.right = [Float](repeating: 0, count: capacity)
    }

    var framesAvailable: Int {
        lock.lock(); defer { lock.unlock() }
        return available
    }

    func reset() {
        lock.lock()
        writeIndex = 0; readIndex = 0; available = 0
        left = [Float](repeating: 0, count: capacity)
        right = [Float](repeating: 0, count: capacity)
        lock.unlock()
    }

    func write(_ srcL: UnsafePointer<Float>, _ srcR: UnsafePointer<Float>, frames: Int) {
        guard frames > 0 else { return }
        lock.lock()
        var w = writeIndex
        var count = frames
        var i = 0
        // Drop oldest frames if the consumer fell behind.
        if count > capacity {
            i = count - capacity
            count = capacity
        }
        while i < frames {
            let room = capacity - w
            let chunk = min(count, room)
            for k in 0..<chunk {
                left[w + k] = srcL[i + k]
                right[w + k] = srcR[i + k]
            }
            w = (w + chunk) % capacity
            i += chunk
            count -= chunk
        }
        writeIndex = w
        available = min(capacity, available + frames)
        lock.unlock()
    }

    /// Returns frames actually written; pads with silence on underrun.
    func read(into dstL: UnsafeMutablePointer<Float>, _ dstR: UnsafeMutablePointer<Float>, frames: Int) -> Int {
        lock.lock()
        // The tap and the output device run off their own clocks. Left alone,
        // any startup backlog (or slow drift) becomes permanent latency, so the
        // buffer is capped: excess frames are dropped instead of accumulating.
        if available > maxFrames {
            let drop = available - maxFrames
            readIndex = (readIndex + drop) % capacity
            available -= drop
            droppedFrames += drop
        }
        let n = min(frames, available)
        var r = readIndex
        var remaining = n
        var o = 0
        while remaining > 0 {
            let room = capacity - r
            let chunk = min(remaining, room)
            for k in 0..<chunk {
                dstL[o + k] = left[r + k]
                dstR[o + k] = right[r + k]
            }
            r = (r + chunk) % capacity
            o += chunk
            remaining -= chunk
        }
        if n < frames {
            for k in n..<frames { dstL[k] = 0; dstR[k] = 0 }
        }
        readIndex = r
        available -= n
        lock.unlock()
        return n
    }

    /// Drops everything but the newest `keep` frames. Used right after the
    /// engine starts, so capture that happened during setup is not heard late.
    func trim(keep: Int) {
        lock.lock()
        let target = max(0, min(keep, available))
        if available > target {
            let drop = available - target
            readIndex = (readIndex + drop) % capacity
            available = target
            droppedFrames += drop
        }
        lock.unlock()
    }

    private(set) var droppedFrames = 0
}
