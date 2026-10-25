import CoreMedia
import CoreVideo
import Foundation
import simd

/// Pure pieces of the capture package format (CLAUDE.md Section 5 plus
/// IOS_CAPTURE_PLAN.md Section 7). Kept free of ARKit and AVFoundation so the
/// unit tests run anywhere.
enum RecordingFormat {
    /// Depth and confidence frames are recorded at 10 Hz.
    static let depthInterval: TimeInterval = 0.1

    /// H.264 average bit rate for the 1920x1440, 30 fps moment video.
    static let videoBitRate = 8_000_000

    /// True when the next depth frame is due. 5 ms of slack absorbs frame
    /// timestamp jitter so 10 Hz lands on every 3rd frame at 30 fps and every
    /// 6th at 60 fps, without letting an early frame sneak in.
    static func isDepthDue(at timestamp: TimeInterval, lastDepth: TimeInterval?) -> Bool {
        guard let lastDepth else { return true }
        return timestamp - lastDepth >= depthInterval - 0.005
    }

    /// Sample time relative to the moment's first frame `t0`. Video uses the
    /// 600 timescale the plan specifies (exact for 24/25/30/60 fps).
    static func videoTime(_ timestamp: TimeInterval, t0: TimeInterval) -> CMTime {
        CMTime(seconds: timestamp - t0, preferredTimescale: 600)
    }

    /// Shifts an audio buffer's timing so it starts relative to `t0`. ARKit
    /// delivers audio on the same clock as `ARFrame.timestamp`.
    static func retimedAudio(_ buffer: CMSampleBuffer, t0: TimeInterval) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        guard CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr,
              count > 0
        else { return nil }
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count) == noErr
        else { return nil }

        let offset = CMTime(seconds: t0, preferredTimescale: 1_000_000_000)
        for k in timing.indices {
            timing[k].presentationTimeStamp = CMTimeSubtract(timing[k].presentationTimeStamp, offset)
            if timing[k].decodeTimeStamp.isValid {
                timing[k].decodeTimeStamp = CMTimeSubtract(timing[k].decodeTimeStamp, offset)
            }
        }
        var out: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(
            allocator: nil, sampleBuffer: buffer, sampleTimingEntryCount: count,
            sampleTimingArray: &timing, sampleBufferOut: &out) == noErr
        else { return nil }
        return out
    }

    // MARK: Depth

    /// Meters to whole millimeters. Missing or invalid depth becomes 0, which
    /// the server and web treat as "no data".
    static func millimeters(_ meters: Float) -> UInt16 {
        guard meters.isFinite, meters > 0 else { return 0 }
        return UInt16(min(65_535, (meters * 1000).rounded()))
    }

    /// Converts a Float32 depth map (meters) to row-major little-endian UInt16
    /// millimeters, dropping any row padding. 256x192 is about 49k values.
    static func millimeterData(fromDepth buffer: CVPixelBuffer) -> Data? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32 else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }

        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        var out = Data(count: width * height * 2)
        out.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: UInt16.self)
            for row in 0..<height {
                let src = (base + row * bytesPerRow).assumingMemoryBound(to: Float32.self)
                for col in 0..<width {
                    dst[row * width + col] = millimeters(src[col]).littleEndian
                }
            }
        }
        return out
    }

    /// Copies a one-byte-per-pixel confidence map (0 low, 1 medium, 2 high),
    /// dropping any row padding.
    static func confidenceData(from buffer: CVPixelBuffer) -> Data? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8 else { return nil }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }

        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        var out = Data(capacity: width * height)
        for row in 0..<height {
            out.append(base.advanced(by: row * bytesPerRow).assumingMemoryBound(to: UInt8.self), count: width)
        }
        return out
    }
}

/// One line of frames.jsonl.
struct FrameLine {
    /// Index of the video frame in the video file; nil for scan-phase lines, which have no video.
    var index: Int?
    /// Seconds relative to the moment's first frame. Negative during the scan.
    var t: Double
    /// Camera-to-world, ARKit world meters, y up.
    var cameraToWorld: simd_float4x4
    /// fx, fy, cx, cy for the full-resolution video frame.
    var intrinsics: SIMD4<Float>
    /// "normal", "limited" or "notAvailable".
    var tracking: String
    /// Index into depth.bin / confidence.bin when this frame has depth.
    var depthIndex: Int?
    /// "scan" or "moment".
    var phase: String

    func json() -> String {
        let c = cameraToWorld.columns
        // Column-major: all of column 0, then column 1, ...
        let T = [c.0, c.1, c.2, c.3].flatMap { [$0.x, $0.y, $0.z, $0.w] }
        let K = [intrinsics.x, intrinsics.y, intrinsics.z, intrinsics.w]
        func list(_ values: [Float]) -> String {
            "[" + values.map { $0.isFinite ? "\($0)" : "0" }.joined(separator: ",") + "]"
        }
        let i = index.map(String.init) ?? "null"
        let d = depthIndex.map(String.init) ?? "null"
        return "{\"i\":\(i),\"t\":\(String(format: "%.6f", t)),\"T\":\(list(T)),\"K\":\(list(K)),"
            + "\"track\":\"\(tracking)\",\"d\":\(d),\"phase\":\"\(phase)\"}"
    }
}

/// manifest.json. Field names are the contract with the server and web.
struct CaptureManifest: Codable, Equatable {
    var format = "braindance.capture"
    var version = 1
    var id: String
    var createdAt: String
    var device: String
    var title: String
    var attendees: [String]
    var coordinates = "arkit-world-meters-y-up"
    var imageOrientation = "landscapeRight"
    var video: Video
    var audio: Audio
    var depth: Depth
    var mesh = Mesh(present: false)
    var room: Room?
    /// Missing when on-device recognition wasn't available; `warnings` says why.
    var transcript: Transcript?
    var keyframes: Keyframes?
    var phases: Phases
    var warnings: [String]

    struct Video: Codable, Equatable {
        var file = "video.mp4"
        var width: Int
        var height: Int
        var fps: Int
        var durationSec: Double
        var frameCount: Int
    }

    struct Audio: Codable, Equatable {
        var inVideo: Bool
        var sampleRate: Int
        var channels: Int
    }

    struct Depth: Codable, Equatable {
        var file = "depth.bin"
        var confidenceFile = "confidence.bin"
        var width: Int
        var height: Int
        var unit = "mm"
        var rateHz: Int
        var count: Int
    }

    struct Mesh: Codable, Equatable {
        var present: Bool
    }

    struct Room: Codable, Equatable {
        var ply = "room.ply"
        var bin = "room.bin"
        var points: Int
        var voxelMeters: Double
        var source = "on-device"
    }

    struct Transcript: Codable, Equatable {
        var file = "transcript.json"
        var locale: String
        var onDevice = true
    }

    struct Keyframes: Codable, Equatable {
        var dir = "keyframes"
        var everySec = 1
        var count: Int
    }

    struct Phases: Codable, Equatable {
        var scan: Span?
        var moment: Span
    }

    struct Span: Codable, Equatable {
        var tStart: Double
        var tEnd: Double
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

// MARK: Keyframes

extension RecordingFormat {
    /// Keyframes are taken once per whole second of the moment that has video.
    static func keyframeSeconds(durationSec: Double) -> [Int] {
        guard durationSec > 0 else { return [] }
        let last = Int((durationSec - 0.001).rounded(.down))
        return Array(0...max(0, last))
    }

    /// "keyframes/k0012.jpg" for second 12.
    static func keyframeName(second: Int) -> String {
        String(format: "keyframes/k%04d.jpg", second)
    }
}

// MARK: Transcript

struct TranscriptWord: Codable, Equatable {
    var start: Double
    var end: Double
    var word: String
}

struct TranscriptSegment: Codable, Equatable {
    var start: Double
    var end: Double
    var text: String
    var words: [TranscriptWord]
}

/// transcript.json. Times are moment seconds, the same clock as frames.jsonl `t`.
struct TranscriptFile: Codable, Equatable {
    var locale: String
    var segments: [TranscriptSegment]

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

enum TranscriptBuilder {
    /// A silence at least this long starts a new segment.
    static let pauseSeconds = 0.8

    /// Groups recognized words into sentence-like segments: a new segment
    /// starts after a long pause or after a word ending in . ? or !
    static func segments(from words: [TranscriptWord]) -> [TranscriptSegment] {
        var segments: [TranscriptSegment] = []
        var current: [TranscriptWord] = []

        func flush() {
            guard let first = current.first, let last = current.last else { return }
            segments.append(TranscriptSegment(
                start: round3(first.start), end: round3(last.end),
                text: current.map(\.word).joined(separator: " "),
                words: current.map { TranscriptWord(start: round3($0.start), end: round3($0.end), word: $0.word) }))
            current = []
        }

        for word in words where !word.word.trimmingCharacters(in: .whitespaces).isEmpty {
            if let previous = current.last {
                let paused = word.start - previous.end >= pauseSeconds
                let sentenceEnded = previous.word.last.map { ".?!".contains($0) } ?? false
                if paused || sentenceEnded { flush() }
            }
            current.append(word)
        }
        flush()
        return segments
    }

    private static func round3(_ value: Double) -> Double {
        (value * 1000).rounded() / 1000
    }
}

// MARK: Upload

enum UploadPlan {
    /// The web shows the room as soon as manifest.json, room.bin and thumb.jpg
    /// arrive, so those go first; the big files go last.
    static func order(_ files: [String]) -> [String] {
        func rank(_ name: String) -> Int {
            switch name {
            case "manifest.json": return 0
            case "room.bin": return 1
            case "thumb.jpg": return 2
            case "transcript.json": return 3
            case _ where name.hasPrefix("keyframes/"): return 4
            case "frames.jsonl": return 5
            case "room.ply": return 6
            case _ where name.hasPrefix("video."): return 7
            case "confidence.bin": return 8
            case "depth.bin": return 9
            default: return 10
            }
        }
        return files
            .filter { !$0.hasPrefix(".") && !$0.hasSuffix(".zip") && !$0.contains("/.") }
            .sorted { (rank($0), $0) < (rank($1), $1) }
    }

    /// Joins the guide's base URL (as typed in Settings) with an API path.
    /// Adds https:// when no scheme was typed and drops trailing slashes.
    static func url(base: String, path: String) -> URL? {
        var trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let encodedPath = path
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
        return URL(string: trimmed + encodedPath)
    }
}
