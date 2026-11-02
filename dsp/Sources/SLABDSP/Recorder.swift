import Foundation
import AVFoundation

/// Writes the processed output to a WAV so the DSP can be verified objectively.
final class Recorder {
    private let path: String
    private let graph: DSPGraph
    private var file: AVAudioFile?
    private var started = false

    init(path: String, graph: DSPGraph) {
        self.path = path
        self.graph = graph
    }

    func start() throws {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.removeItem(at: url)
        // Record from the mixer by re-tapping the engine's output chain.
        let engine = graph.engineForRecording
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        self.file = file
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            try? self?.file?.write(from: buffer)
        }
        started = true
    }

    func stop() {
        guard started else { return }
        graph.engineForRecording.mainMixerNode.removeTap(onBus: 0)
        started = false
        file = nil
    }
}
