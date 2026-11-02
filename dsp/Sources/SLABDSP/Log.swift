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
