import Foundation

let slabLogURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/SLAB/dsp.log")

func slabLog(_ message: String) {
    let line = message + "\n"
    FileHandle.standardError.write(Data(line.utf8))
    try? FileManager.default.createDirectory(
        at: slabLogURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: slabLogURL) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? Data(line.utf8).write(to: slabLogURL)
    }
}

/// Called once at launch. The helper can run for weeks as a login item.
func slabTrimLog(keepingLast keep: Int = 256 * 1024) {
    guard let data = try? Data(contentsOf: slabLogURL), data.count > keep * 4 else { return }
    try? data.suffix(keep).write(to: slabLogURL)
}
