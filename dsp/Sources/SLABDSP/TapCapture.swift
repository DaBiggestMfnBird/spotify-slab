import Foundation
import SLABCore
import CoreAudio
import AVFoundation

enum TapError: Error, CustomStringConvertible {
    case noProcess(String)
    case tapFailed(OSStatus)
    case aggregateFailed(OSStatus)
    case ioProcFailed(OSStatus)
    case noStreamFormat

    var description: String {
        switch self {
        case .noProcess(let name): return "could not find a running audio process for \(name)"
        case .tapFailed(let s): return "AudioHardwareCreateProcessTap failed (\(s))"
        case .aggregateFailed(let s): return "AudioHardwareCreateAggregateDevice failed (\(s))"
        case .ioProcFailed(let s): return "AudioDeviceCreateIOProcIDWithBlock failed (\(s))"
        case .noStreamFormat: return "tap reported no usable stream format"
        }
    }
}

struct TapFormat {
    let sampleRate: Double
    let channels: Int
    let bytesPerFrame: UInt32
    let isFloat: Bool
    let isInterleaved: Bool
}

/// Captures one process's audio into a ring buffer using a Core Audio process tap.
///
/// The tap is private and muted-when-tapped: Spotify's own output is silenced so
/// the processed copy is the only thing heard. If this helper dies, audio stops —
/// the caller is expected to keep the process alive.
final class TapCapture {
    private(set) var aggregateID = AudioDeviceID(0)
    private(set) var tapID = AudioObjectID(0)
    private(set) var format: TapFormat?
    private(set) var capturedFrames = 0
    private(set) var ioCallbacks = 0

    private var ioProcID: AudioDeviceIOProcID?
    private let ring: Deck
    private let lock = NSLock()
    private var scratchL: [Float] = []
    private var scratchR: [Float] = []

    init(ring: Deck) {
        self.ring = ring
    }

    static func processObject(forPID pid: pid_t) -> AudioObjectID? {
        var pidValue = pid
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var objectID = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address,
            UInt32(MemoryLayout<pid_t>.size), &pidValue,
            &size, &objectID
        )
        guard status == noErr, objectID != 0 else { return nil }
        return objectID
    }

    /// Exact-name match, so "Spotify" never picks up "Spotify Helper". Polled every
    /// couple of seconds for the life of the app, hence no pgrep subprocess here.
    static func pids(named name: String) -> [pid_t] {
        let capacity = Int(proc_listallpids(nil, 0)) + 64
        guard capacity > 64 else { return [] }
        var all = [pid_t](repeating: 0, count: capacity)
        let count = all.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        guard count > 0 else { return [] }

        var buffer = [CChar](repeating: 0, count: 256)
        return all.prefix(Int(count)).filter { pid in
            guard pid > 0, proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
            return String(cString: buffer) == name
        }
    }

    func start(processObjectID: AudioObjectID, label: String) throws {
        let desc = CATapDescription(stereoMixdownOfProcesses: [processObjectID])
        desc.name = "SLAB — \(label)"
        desc.isPrivate = true
        desc.muteBehavior = .mutedWhenTapped

        var createdTap = AudioObjectID(0)
        let tapStatus = AudioHardwareCreateProcessTap(desc, &createdTap)
        guard tapStatus == noErr, createdTap != 0 else { throw TapError.tapFailed(tapStatus) }
        tapID = createdTap

        // The tap list is an array of dictionaries keyed by kAudioSubTapUIDKey.
        // An array of plain UID strings is accepted but silently attaches nothing.
        let tapUID = Self.tapUID(of: createdTap) ?? desc.uuid.uuidString
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "SLAB Tap",
            kAudioAggregateDeviceUIDKey: "slab-tap-" + UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [Any](),
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID]],
        ]

        var createdAggregate = AudioDeviceID(0)
        let aggStatus = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &createdAggregate)
        guard aggStatus == noErr, createdAggregate != 0 else {
            AudioHardwareDestroyProcessTap(tapID)
            throw TapError.aggregateFailed(aggStatus)
        }
        aggregateID = createdAggregate

        guard let fmt = Self.streamFormat(of: createdAggregate) else {
            stop()
            throw TapError.noStreamFormat
        }
        format = fmt
        scratchL = [Float](repeating: 0, count: 8192)
        scratchR = [Float](repeating: 0, count: 8192)

        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, createdAggregate, nil) { [weak self] _, inInputData, _, _, _ in
            self?.consume(inInputData, format: fmt)
        }
        guard status == noErr, let procID else {
            stop()
            throw TapError.ioProcFailed(status)
        }
        ioProcID = procID

        let startStatus = AudioDeviceStart(createdAggregate, procID)
        guard startStatus == noErr else {
            stop()
            throw TapError.ioProcFailed(startStatus)
        }

        slabLog("tap \(createdTap) · aggregate \(createdAggregate) · \(Int(fmt.sampleRate)) Hz")
    }

    private func consume(_ input: UnsafePointer<AudioBufferList>, format: TapFormat) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard abl.count > 0, let raw = abl[0].mData else { return }
        let frames = Int(abl[0].mDataByteSize) / max(1, Int(format.bytesPerFrame))
        guard frames > 0, frames <= scratchL.count else { return }

        ioCallbacks += 1
        capturedFrames += frames

        lock.lock()
        defer { lock.unlock() }

        if format.isFloat && !format.isInterleaved && abl.count >= 2, let raw2 = abl[1].mData {
            ring.write(
                raw.assumingMemoryBound(to: Float.self),
                raw2.assumingMemoryBound(to: Float.self),
                frames: frames
            )
        } else if format.isFloat && !format.isInterleaved {
            let channel = raw.assumingMemoryBound(to: Float.self)
            ring.write(channel, channel, frames: frames)
        } else if format.isFloat {
            let interleaved = raw.assumingMemoryBound(to: Float.self)
            let channels = max(1, format.channels)
            for i in 0..<frames {
                scratchL[i] = interleaved[i * channels]
                scratchR[i] = channels > 1 ? interleaved[i * channels + 1] : interleaved[i * channels]
            }
            ring.write(scratchL, scratchR, frames: frames)
        } else {
            let samples = raw.assumingMemoryBound(to: Int16.self)
            let channels = max(1, format.channels)
            for i in 0..<frames {
                scratchL[i] = Float(samples[i * channels]) / 32768.0
                scratchR[i] = channels > 1 ? Float(samples[i * channels + 1]) / 32768.0 : scratchL[i]
            }
            ring.write(scratchL, scratchR, frames: frames)
        }
    }

    private static func tapUID(of tap: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: CFString?
        var size = UInt32(MemoryLayout<CFString?>.size)
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(tap, &address, 0, nil, &size, pointer)
        }
        guard status == noErr, let uid = value else { return nil }
        return uid as String
    }

    private static func streamFormat(of device: AudioDeviceID) -> TapFormat? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &asbd)
        guard status == noErr, asbd.mSampleRate > 0 else {
            return TapFormat(sampleRate: 48_000, channels: 2, bytesPerFrame: 8, isFloat: true, isInterleaved: false)
        }
        return TapFormat(
            sampleRate: asbd.mSampleRate,
            channels: Int(asbd.mChannelsPerFrame),
            bytesPerFrame: asbd.mBytesPerFrame,
            isFloat: (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0,
            isInterleaved: (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        )
    }

    func stop() {
        if aggregateID != 0 {
            if let procID = ioProcID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
                ioProcID = nil
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = 0
        }
        if tapID != 0 {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = 0
        }
        format = nil
    }
}
