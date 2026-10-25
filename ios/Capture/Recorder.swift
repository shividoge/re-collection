import ARKit
import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// Writes the capture package: depth v2 (depth.bin + depth.index.json) at
/// 10 Hz plus a frames.jsonl pose line per frame during both the scan and the
/// moment, and video.mp4 (H.264 + AAC, so every browser plays it) and one
/// keyframe per whole second during the moment only (IOS_CAPTURE_PLAN.md 6,
/// docs/capture-format.md).
///
/// Every method runs on the capture queue. Conversions happen right there
/// (a 256x192 depth map takes microseconds) and the resulting `Data` goes to
/// a serial file queue, so no ARFrame or depth buffer outlives the callback.
final class CaptureRecorder {
    enum Outcome {
        case ok
        case reachedTimeLimit
        case failed(String)
    }

    struct MomentResult {
        let durationSec: Double
        let frameCount: Int
        let depthCount: Int
        /// keyframes/k0000.jpg up to k(count-1), with no gaps.
        var keyframeCount = 0
        let videoFile: String
        let videoSize: CGSize
        let fps: Int
        let audioSampleRate: Int
        let scanSpan: CaptureManifest.Span?
        var warnings: [String]
        /// Heard the moment while it recorded; nil when live recognition wasn't available.
        let transcriber: LiveTranscriber?
    }

    static let maxMomentSeconds: Double = 180
    static let videoFileName = "video.mp4"

    private enum Mode { case scan, paused, waitingForMoment, moment, finished }

    let folder: URL
    /// The ARKit video format's frame rate; written to the manifest.
    let fps: Int
    private var mode: Mode = .scan

    private let fileQueue = DispatchQueue(label: "braindance.files", qos: .utility)
    private let depthHandle: FileHandle
    private let framesHandle: FileHandle
    /// Only used on the file queue, so compressing a chunk never blocks the camera.
    private let depthChunks: DepthChunkWriter
    /// Set on the file queue when a write fails (usually a full disk).
    private var writeError: Error?

    private var depthCount = 0
    private var lastDepthTimestamp: TimeInterval?

    /// Scan lines wait in memory until the moment's t0 is known, since every
    /// line's `t` is relative to it. About 1,800 small structs per minute.
    private var pendingScanLines: [(timestamp: TimeInterval, line: FrameLine)] = []
    private var scanStart: TimeInterval?
    private var scanEnd: TimeInterval?

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var videoSize = CGSize.zero
    private var audioSampleRate = 48_000
    private var t0: TimeInterval?
    private var lastMomentTimestamp: TimeInterval?
    private var frameCount = 0
    private var droppedVideoFrames = 0
    private var droppedAudioBuffers = 0
    private var thumbnailTaken = false
    /// The next whole second of moment time that needs a keyframe.
    private var nextKeyframeSecond = 0
    private var keyframesStopped = false
    /// File queue only: keyframes written so far (always 0..<count) and why they stopped.
    private var keyframeCount = 0
    private var keyframeFailure: String?
    private var transcriber: LiveTranscriber?
    private lazy var ciContext = CIContext()

    init(folder: URL, fps: Int) throws {
        self.folder = folder
        self.fps = fps
        func open(_ name: String) throws -> FileHandle {
            let url = folder.appending(path: name)
            guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
            }
            return try FileHandle(forWritingTo: url)
        }
        let depthHandle = try open("depth.bin")
        self.depthHandle = depthHandle
        framesHandle = try open("frames.jsonl")
        depthChunks = DepthChunkWriter(width: RecordingFormat.depthWidth, height: RecordingFormat.depthHeight) { chunk in
            try depthHandle.write(contentsOf: chunk)
        }
    }

    // MARK: Phase changes

    /// The room scan ended; stop logging scan frames until the moment starts.
    func pauseScan() {
        if mode == .scan { mode = .paused }
    }

    /// The writer starts on the next frame, which becomes t0.
    func beginMoment() {
        guard mode == .scan || mode == .paused else { return }
        mode = .waitingForMoment
    }

    // MARK: Per-frame

    func handle(_ frame: ARFrame) -> Outcome {
        switch mode {
        case .scan:
            recordScanFrame(frame)
            return .ok
        case .waitingForMoment:
            if let error = startMoment(with: frame) { return .failed(error) }
            return recordMomentFrame(frame)
        case .moment:
            return recordMomentFrame(frame)
        case .paused, .finished:
            return .ok
        }
    }

    func handleAudio(_ buffer: CMSampleBuffer) {
        guard mode == .moment, let t0, let audioInput else { return }
        // Drop audio from before the first video frame.
        guard CMSampleBufferGetPresentationTimeStamp(buffer).seconds >= t0 else { return }
        // Every buffer goes to the recognizer, even one the writer drops.
        transcriber?.append(buffer, t0: t0)
        guard audioInput.isReadyForMoreMediaData,
              let retimed = RecordingFormat.retimedAudio(buffer, t0: t0),
              audioInput.append(retimed)
        else {
            droppedAudioBuffers += 1
            return
        }
    }

    private func recordScanFrame(_ frame: ARFrame) {
        let ts = frame.timestamp
        if scanStart == nil { scanStart = ts }
        scanEnd = ts
        let d = writeDepthIfDue(frame)
        pendingScanLines.append((ts, line(for: frame, index: nil, t: 0, depthIndex: d, phase: "scan")))
    }

    private func startMoment(with frame: ARFrame) -> String? {
        let size = frame.camera.imageResolution
        let videoURL = folder.appending(path: Self.videoFileName)
        try? FileManager.default.removeItem(at: videoURL)
        do {
            try FileManager.default.createDirectory(
                at: folder.appending(path: "keyframes", directoryHint: .isDirectory), withIntermediateDirectories: true)
        } catch {
            return "The keyframes folder couldn't be created: \(error.localizedDescription)"
        }

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: videoURL, fileType: .mp4)
        } catch {
            return "The video file couldn't be created: \(error.localizedDescription)"
        }

        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            // H.264 rather than HEVC: Chrome on Windows can't play HEVC.
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
            // The encoder's default for 1920x1440 is about 19 Mbps (71 MB per 30 s).
            // 8 Mbps looks the same for a handheld visit at well under half the size.
            // A keyframe every second keeps seeking in the browser quick.
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: RecordingFormat.videoBitRate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps,
            ] as [String: Any],
        ])
        video.expectsMediaDataInRealTime = true
        // Stored in the sensor's landscape orientation, untransformed; the
        // manifest says "landscapeRight" and the server rotates for display.
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: nil)

        let sessionRate = AVAudioSession.sharedInstance().sampleRate
        audioSampleRate = sessionRate > 0 ? Int(sessionRate) : 48_000
        let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: audioSampleRate,
            AVEncoderBitRateKey: 96_000,
        ])
        audio.expectsMediaDataInRealTime = true

        guard writer.canAdd(video), writer.canAdd(audio) else { return "The video writer rejected its inputs." }
        writer.add(video)
        writer.add(audio)
        // Make the image context now, not on the first keyframe, so frame 0 isn't late.
        _ = ciContext
        guard writer.startWriting() else {
            return "Video recording couldn't start: \(writer.error?.localizedDescription ?? "unknown error")"
        }
        writer.startSession(atSourceTime: .zero)

        self.writer = writer
        self.videoInput = video
        self.audioInput = audio
        self.adaptor = adaptor
        self.videoSize = size
        let t0 = frame.timestamp
        self.t0 = t0
        mode = .moment
        transcriber = LiveTranscriber.start()

        // Now that t0 is known, the scan lines can be written before the moment's.
        let scanLines = pendingScanLines.map { entry -> String in
            var line = entry.line
            line.t = entry.timestamp - t0
            return line.json()
        }
        pendingScanLines = []
        if !scanLines.isEmpty {
            write(Data((scanLines.joined(separator: "\n") + "\n").utf8), to: framesHandle)
        }
        return nil
    }

    private func recordMomentFrame(_ frame: ARFrame) -> Outcome {
        guard let t0, let writer, let videoInput, let adaptor else { return .ok }
        let ts = frame.timestamp
        let t = ts - t0
        guard t >= 0 else { return .ok }
        if t >= Self.maxMomentSeconds { return .reachedTimeLimit }

        if writer.status == .failed {
            return .failed("Video recording failed: \(writer.error?.localizedDescription ?? "unknown error")")
        }
        guard videoInput.isReadyForMoreMediaData,
              adaptor.append(frame.capturedImage, withPresentationTime: RecordingFormat.videoTime(ts, t0: t0))
        else {
            // Skip the pose line too, so frames.jsonl keeps one line per video frame.
            droppedVideoFrames += 1
            return .ok
        }

        let index = frameCount
        frameCount += 1
        lastMomentTimestamp = ts
        let d = writeDepthIfDue(frame)
        write(Data((line(for: frame, index: index, t: t, depthIndex: d, phase: "moment").json() + "\n").utf8),
              to: framesHandle)

        if !thumbnailTaken, t >= 2 {
            thumbnailTaken = true
            saveThumbnail(frame.capturedImage)
        }
        if !keyframesStopped, let seconds = RecordingFormat.keyframeSecondsDue(at: t, next: nextKeyframeSecond) {
            nextKeyframeSecond = seconds.upperBound + 1
            saveKeyframe(frame.capturedImage, seconds: seconds)
        }
        return .ok
    }

    // MARK: Finish

    /// Finishes the video and closes every file. `completion` runs on an
    /// arbitrary queue once everything is on disk.
    func finishMoment(completion: @escaping (Result<MomentResult, Error>) -> Void) {
        guard mode == .moment, let writer, let t0 else {
            mode = .finished
            transcriber?.cancel()
            closeFiles(cancelWriter: true) {}
            completion(.failure(RecorderError.noFrames))
            return
        }
        mode = .finished
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()

        var warnings: [String] = []
        if droppedVideoFrames > 0 { warnings.append("Dropped \(droppedVideoFrames) video frames because the encoder was busy.") }
        if droppedAudioBuffers > 0 { warnings.append("Dropped \(droppedAudioBuffers) audio buffers.") }

        let scanSpan = scanStart.flatMap { start in
            scanEnd.map { CaptureManifest.Span(tStart: start - t0, tEnd: $0 - t0) }
        }
        let result = MomentResult(
            // Last frame's start plus its own display time.
            durationSec: (lastMomentTimestamp ?? t0) - t0 + 1.0 / Double(max(fps, 1)),
            frameCount: frameCount,
            depthCount: depthCount,
            videoFile: Self.videoFileName,
            videoSize: videoSize,
            fps: fps,
            audioSampleRate: audioSampleRate,
            scanSpan: scanSpan,
            warnings: warnings,
            transcriber: transcriber)

        writer.finishWriting { [self] in
            if writer.status != .completed {
                transcriber?.cancel()
                let message = writer.error?.localizedDescription ?? "unknown error"
                closeFiles(cancelWriter: true) { completion(.failure(RecorderError.videoFailed(message))) }
                return
            }
            closeFiles(cancelWriter: false) { [self] in
                // On the file queue, after every keyframe is on disk.
                if let writeError {
                    completion(.failure(RecorderError.writeFailed(writeError.localizedDescription)))
                    return
                }
                var result = result
                result.keyframeCount = keyframeCount
                if let keyframeFailure { result.warnings.append(keyframeFailure) }
                completion(.success(result))
            }
        }
    }

    /// Abandons the capture. Files written so far stay on disk.
    func cancel() {
        guard mode != .finished else { return }
        mode = .finished
        transcriber?.cancel()
        closeFiles(cancelWriter: true) {}
    }

    private func closeFiles(cancelWriter: Bool, then: @escaping () -> Void) {
        if cancelWriter, let writer, writer.status == .writing { writer.cancelWriting() }
        fileQueue.async { [self] in
            if !cancelWriter, writeError == nil {
                do {
                    let index = try depthChunks.finish()
                    try index.encoded().write(to: folder.appending(path: "depth.index.json"), options: .atomic)
                } catch {
                    writeError = error
                }
            }
            for handle in [depthHandle, framesHandle] {
                do { try handle.close() } catch { writeError = writeError ?? error }
            }
            then()
        }
    }

    // MARK: Helpers

    /// Packs and queues this frame's depth and confidence if 10 Hz says it's
    /// due. Returns the depth index, or nil if no depth was written.
    private func writeDepthIfDue(_ frame: ARFrame) -> Int? {
        guard RecordingFormat.isDepthDue(at: frame.timestamp, lastDepth: lastDepthTimestamp),
              let sceneDepth = frame.smoothedSceneDepth ?? frame.sceneDepth,
              let confidenceMap = sceneDepth.confidenceMap,
              // Every frame must be the size depth.index.json declares.
              CVPixelBufferGetWidth(sceneDepth.depthMap) == RecordingFormat.depthWidth,
              CVPixelBufferGetHeight(sceneDepth.depthMap) == RecordingFormat.depthHeight,
              let packed = RecordingFormat.packedDepthData(depth: sceneDepth.depthMap, confidence: confidenceMap)
        else { return nil }

        lastDepthTimestamp = frame.timestamp
        let index = depthCount
        depthCount += 1
        fileQueue.async { [self] in
            guard writeError == nil else { return }
            do { try depthChunks.append(packed) } catch { writeError = error }
        }
        return index
    }

    private func line(for frame: ARFrame, index: Int?, t: Double, depthIndex: Int?, phase: String) -> FrameLine {
        let K = frame.camera.intrinsics
        return FrameLine(
            index: index,
            t: t,
            cameraToWorld: frame.camera.transform,
            intrinsics: SIMD4<Float>(K[0][0], K[1][1], K[2][0], K[2][1]),
            tracking: Self.trackingName(frame.camera.trackingState),
            depthIndex: depthIndex,
            phase: phase)
    }

    private func write(_ data: Data, to handle: FileHandle) {
        fileQueue.async { [self] in
            guard writeError == nil else { return }
            do { try handle.write(contentsOf: data) } catch { writeError = error }
        }
    }

    /// Renders a copy at most 1024 px on the long side right away, so the
    /// camera's buffer goes straight back to ARKit, then writes it as the
    /// keyframe for each second in `seconds` (more than one only if frames
    /// went missing for over a second). Stored in the sensor's landscape
    /// orientation, like the video.
    private func saveKeyframe(_ pixelBuffer: CVPixelBuffer, seconds: ClosedRange<Int>) {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let scale = RecordingFormat.keyframeScale(width: width, height: height)
        let image = CIImage(cvPixelBuffer: pixelBuffer).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let rect = CGRect(x: 0, y: 0, width: (CGFloat(width) * scale).rounded(), height: (CGFloat(height) * scale).rounded())
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let cgImage = ciContext.createCGImage(image, from: rect, format: .RGBA8, colorSpace: colorSpace)
        else {
            stopKeyframes(at: seconds.lowerBound, "the camera image couldn't be converted")
            return
        }
        let folder = folder
        fileQueue.async { [self] in
            guard keyframeFailure == nil else { return }
            for second in seconds {
                let url = folder.appending(path: RecordingFormat.keyframeName(second: second))
                guard Self.writeJPEG(cgImage, to: url) else {
                    keyframeFailure = "Keyframes stopped at \(second) s: \(url.lastPathComponent) couldn't be written."
                    return
                }
                keyframeCount = second + 1
            }
        }
    }

    /// Keyframes must have no gaps, so the first failure ends them.
    private func stopKeyframes(at second: Int, _ reason: String) {
        keyframesStopped = true
        fileQueue.async { [self] in
            keyframeFailure = keyframeFailure ?? "Keyframes stopped at \(second) s: \(reason)."
        }
    }

    private static func writeJPEG(_ image: CGImage, to url: URL) -> Bool {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            return false
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        return CGImageDestinationFinalize(destination)
    }

    private func saveThumbnail(_ pixelBuffer: CVPixelBuffer) {
        let url = folder.appending(path: "thumb.jpg")
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let context = ciContext
        fileQueue.async {
            guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                  let data = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: [:])
            else { return }
            try? data.write(to: url, options: .atomic)
        }
    }

    private static func trackingName(_ state: ARCamera.TrackingState) -> String {
        switch state {
        case .normal: return "normal"
        case .limited: return "limited"
        case .notAvailable: return "notAvailable"
        }
    }
}

enum RecorderError: LocalizedError {
    case noFrames
    case videoFailed(String)
    case writeFailed(String)

    var errorDescription: String? {
        switch self {
        case .noFrames: return "No video frames were recorded."
        case .videoFailed(let detail): return "The video couldn't be finished (\(detail))."
        case .writeFailed(let detail): return "A capture file couldn't be written (\(detail)). The phone may be out of space."
        }
    }
}
