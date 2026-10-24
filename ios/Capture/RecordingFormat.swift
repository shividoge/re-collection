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
    /// Index of the video frame in video.mov; nil for scan-phase lines, which have no video.
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
    var phases: Phases
    var warnings: [String]

    struct Video: Codable, Equatable {
        var file = "video.mov"
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
