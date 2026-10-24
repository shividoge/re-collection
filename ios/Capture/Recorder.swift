import ARKit
import AVFoundation
import CoreImage

/// Writes the capture package: depth.bin and confidence.bin at 10 Hz plus a
/// frames.jsonl pose line per frame during both the scan and the moment, and
/// video.mov (HEVC + AAC) during the moment only (IOS_CAPTURE_PLAN.md 6).
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
        let videoSize: CGSize
        let audioSampleRate: Int
        let scanSpan: CaptureManifest.Span?
        let warnings: [String]
    }

    static let maxMomentSeconds: Double = 180

    private enum Mode { case scan, paused, waitingForMoment, moment, finished }

    let folder: URL
    private var mode: Mode = .scan

    private let fileQueue = DispatchQueue(label: "braindance.files", qos: .utility)
    private let depthHandle: FileHandle
    private let confidenceHandle: FileHandle
    private let framesHandle: FileHandle
    /// Set on the file queue when a write fails (usually a full disk).
    private var writeError: Error?

    private var depthCount = 0
    private var depthSize = CGSize.zero
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
    private lazy var ciContext = CIContext()

    init(folder: URL) throws {
        self.folder = folder
        func open(_ name: String) throws -> FileHandle {
            let url = folder.appending(path: name)
            guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
            }
            return try FileHandle(forWritingTo: url)
        }
        depthHandle = try open("depth.bin")
        confidenceHandle = try open("confidence.bin")
        framesHandle = try open("frames.jsonl")
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
        let videoURL = folder.appending(path: "video.mov")
        try? FileManager.default.removeItem(at: videoURL)

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: videoURL, fileType: .mov)
        } catch {
            return "The video file couldn't be created: \(error.localizedDescription)"
        }

        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
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
        return .ok
    }

    // MARK: Finish

    /// Finishes the video and closes every file. `completion` runs on an
    /// arbitrary queue once everything is on disk.
    func finishMoment(completion: @escaping (Result<MomentResult, Error>) -> Void) {
        guard mode == .moment, let writer, let t0 else {
            mode = .finished
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
            durationSec: (lastMomentTimestamp ?? t0) - t0 + 1.0 / 30.0,
            frameCount: frameCount,
            depthCount: depthCount,
            videoSize: videoSize,
            audioSampleRate: audioSampleRate,
            scanSpan: scanSpan,
            warnings: warnings)

        writer.finishWriting { [self] in
            if writer.status != .completed {
                completion(.failure(RecorderError.videoFailed(writer.error?.localizedDescription ?? "unknown error")))
                return
            }
            closeFiles(cancelWriter: false) { [self] in
                if let writeError {
                    completion(.failure(RecorderError.writeFailed(writeError.localizedDescription)))
                } else {
                    completion(.success(result))
                }
            }
        }
    }

    /// Abandons the capture. Files written so far stay on disk.
    func cancel() {
        guard mode != .finished else { return }
        mode = .finished
        closeFiles(cancelWriter: true) {}
    }

    private func closeFiles(cancelWriter: Bool, then: @escaping () -> Void) {
        if cancelWriter, let writer, writer.status == .writing { writer.cancelWriting() }
        fileQueue.async { [self] in
            for handle in [depthHandle, confidenceHandle, framesHandle] {
                do { try handle.close() } catch { writeError = writeError ?? error }
            }
            then()
        }
    }

    // MARK: Helpers

    /// Converts and queues this frame's depth and confidence if 10 Hz says
    /// it's due. Returns the depth index, or nil if no depth was written.
    private func writeDepthIfDue(_ frame: ARFrame) -> Int? {
        guard RecordingFormat.isDepthDue(at: frame.timestamp, lastDepth: lastDepthTimestamp),
              let sceneDepth = frame.smoothedSceneDepth ?? frame.sceneDepth,
              let confidenceMap = sceneDepth.confidenceMap,
              let depth = RecordingFormat.millimeterData(fromDepth: sceneDepth.depthMap),
              let confidence = RecordingFormat.confidenceData(from: confidenceMap)
        else { return nil }

        // depth.bin is a flat array of same-sized frames; never mix sizes.
        let size = CGSize(width: CVPixelBufferGetWidth(sceneDepth.depthMap), height: CVPixelBufferGetHeight(sceneDepth.depthMap))
        if depthCount == 0 { depthSize = size } else if size != depthSize { return nil }

        lastDepthTimestamp = frame.timestamp
        let index = depthCount
        depthCount += 1
        write(depth, to: depthHandle)
        write(confidence, to: confidenceHandle)
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
