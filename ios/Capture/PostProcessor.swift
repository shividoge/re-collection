import AVFoundation
import ImageIO
import Speech
import UniformTypeIdentifiers

/// Runs once the moment is recorded: one keyframe per second for Claude and
/// the family review screen, and an on-device transcript with word times.
/// Neither step is fatal; a failure becomes a manifest warning instead.
enum PostProcessor {
    static let keyframeMaxSide: CGFloat = 1024

    // MARK: Keyframes

    /// Writes keyframes/kNNNN.jpg for every whole second of the video and
    /// returns how many it wrote.
    static func makeKeyframes(video: URL, folder: URL, durationSec: Double) async throws -> Int {
        let directory = folder.appending(path: "keyframes", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        generator.maximumSize = CGSize(width: keyframeMaxSide, height: keyframeMaxSide)
        // Within one frame of the whole second is close enough and much faster than exact.
        let tolerance = CMTime(value: 1, timescale: 30)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance

        var written = 0
        for second in RecordingFormat.keyframeSeconds(durationSec: durationSec) {
            let (image, _) = try await generator.image(at: CMTime(seconds: Double(second), preferredTimescale: 600))
            try writeJPEG(image, to: folder.appending(path: RecordingFormat.keyframeName(second: second)))
            written += 1
        }
        return written
    }

    private static func writeJPEG(_ image: CGImage, to url: URL) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw PostProcessError.keyframe("couldn't create \(url.lastPathComponent)")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw PostProcessError.keyframe("couldn't write \(url.lastPathComponent)")
        }
    }

    // MARK: Transcript

    /// Asks for speech recognition permission. Call it early (at scan start)
    /// so the prompt doesn't interrupt saving.
    static func requestSpeechPermission() {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in }
        }
    }

    /// Transcribes the video's audio on the phone (nothing leaves the device)
    /// and writes transcript.json. An empty recording gives an empty transcript.
    static func transcribe(video: URL, folder: URL, localeIdentifier: String = "en-US") async throws -> TranscriptFile {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            throw PostProcessError.transcript("speech recognition isn't allowed. Turn it on in Settings > Braindance")
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            throw PostProcessError.transcript("no speech recognizer for \(localeIdentifier)")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw PostProcessError.transcript("on-device recognition for \(localeIdentifier) isn't installed on this phone")
        }

        // The recognizer reads audio files; pull the audio track out of the video first.
        let audioURL = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: audioURL) }
        guard let export = AVAssetExportSession(asset: AVURLAsset(url: video), presetName: AVAssetExportPresetAppleM4A) else {
            throw PostProcessError.transcript("couldn't read the video's audio")
        }
        try await export.export(to: audioURL, as: .m4a)

        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true

        let words: [TranscriptWord]
        do {
            let result = try await recognize(request, with: recognizer)
            words = result.bestTranscription.segments.map {
                TranscriptWord(start: $0.timestamp, end: $0.timestamp + $0.duration, word: $0.substring)
            }
        } catch let error as NSError where error.domain == "kAFAssistantErrorDomain" && error.code == 1110 {
            words = []   // "No speech detected": nobody spoke, which is a valid answer
        }

        let transcript = TranscriptFile(locale: localeIdentifier, segments: TranscriptBuilder.segments(from: words))
        try transcript.encoded().write(to: folder.appending(path: "transcript.json"), options: .atomic)
        return transcript
    }

    private static func recognize(_ request: SFSpeechRecognitionRequest, with recognizer: SFSpeechRecognizer) async throws -> SFSpeechRecognitionResult {
        try await withCheckedThrowingContinuation { continuation in
            var resumed = false   // the handler can fire more than once
            recognizer.recognitionTask(with: request) { result, error in
                guard !resumed else { return }
                if let error {
                    resumed = true
                    continuation.resume(throwing: error)
                } else if let result, result.isFinal {
                    resumed = true
                    continuation.resume(returning: result)
                }
            }
        }
    }
}

enum PostProcessError: LocalizedError {
    case keyframe(String)
    case transcript(String)

    var errorDescription: String? {
        switch self {
        case .keyframe(let detail): return "Keyframes failed: \(detail)."
        case .transcript(let detail): return "No transcript: \(detail)."
        }
    }
}
