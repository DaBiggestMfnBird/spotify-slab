import Foundation
import SLABWindows

/// Where SLAB DSP keeps what it remembers between runs: %LOCALAPPDATA%\SLAB.
let slabFolder: URL? = {
    var path = [CChar](repeating: 0, count: 1_024)
    slab_data_folder(&path, Int32(path.count))
    let folder = String(cString: path)
    return folder.isEmpty ? nil : URL(fileURLWithPath: folder, isDirectory: true)
}()

/// %LOCALAPPDATA%\SLAB\dsp.log, as the Mac keeps ~/Library/Logs/SLAB/dsp.log.
let slabLogURL = slabFolder?.appendingPathComponent("dsp.log")

private let logLock = NSLock()

func slabLog(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(message)\n"
    logLock.lock()
    defer { logLock.unlock() }
    guard let url = slabLogURL else { return }
    if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? Data(line.utf8).write(to: url)
    }
}

/// Called once at launch. The helper can run for weeks from Start at Login.
func slabTrimLog(keepingLast keep: Int = 256 * 1024) {
    guard let url = slabLogURL, let data = try? Data(contentsOf: url), data.count > keep * 4 else { return }
    try? data.suffix(keep).write(to: url)
}
