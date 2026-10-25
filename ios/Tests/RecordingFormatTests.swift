import CoreMedia
import CoreVideo
import simd
import XCTest
@testable import BraindanceCapture

final class DepthConversionTests: XCTestCase {
    func testMetersToMillimeters() {
        XCTAssertEqual(RecordingFormat.millimeters(1.2345), 1235)
        XCTAssertEqual(RecordingFormat.millimeters(0.0004), 0)
        XCTAssertEqual(RecordingFormat.millimeters(100), 65_535)   // clamps instead of overflowing
        XCTAssertEqual(RecordingFormat.millimeters(.nan), 0)
        XCTAssertEqual(RecordingFormat.millimeters(.infinity), 0)
        XCTAssertEqual(RecordingFormat.millimeters(-1), 0)
    }

    private func pixelBuffer(_ width: Int, _ height: Int, _ format: OSType) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, width, height, format, nil, &buffer), kCVReturnSuccess)
        return try XCTUnwrap(buffer)
    }

    func testDepthAndConfidenceBecomePackedRowMajorLittleEndianPixels() throws {
        let depth = try pixelBuffer(3, 2, kCVPixelFormatType_DepthFloat32)
        let confidence = try pixelBuffer(3, 2, kCVPixelFormatType_OneComponent8)

        CVPixelBufferLockBaseAddress(depth, [])
        CVPixelBufferLockBaseAddress(confidence, [])
        let depthBase = try XCTUnwrap(CVPixelBufferGetBaseAddress(depth))
        let confidenceBase = try XCTUnwrap(CVPixelBufferGetBaseAddress(confidence))
        let meters: [[Float]] = [[0.5, 1.0, 1.5], [2.0, .nan, 20]]
        for row in 0..<2 {
            let d = (depthBase + row * CVPixelBufferGetBytesPerRow(depth)).assumingMemoryBound(to: Float32.self)
            let c = (confidenceBase + row * CVPixelBufferGetBytesPerRow(confidence)).assumingMemoryBound(to: UInt8.self)
            for col in 0..<3 {
                d[col] = meters[row][col]
                c[col] = UInt8((row * 3 + col) % 3)
            }
        }
        CVPixelBufferUnlockBaseAddress(confidence, [])
        CVPixelBufferUnlockBaseAddress(depth, [])

        let data = try XCTUnwrap(RecordingFormat.packedDepthData(depth: depth, confidence: confidence))
        XCTAssertEqual(data.count, 3 * 2 * 2)   // row padding dropped
        let bytes = [UInt8](data)
        let packed = Swift.stride(from: 0, to: bytes.count, by: 2).map { UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8 }
        // 20 m clamps to 16,383 mm; NaN is "no data" (0) but keeps its confidence.
        XCTAssertEqual(packed, [500, 1000 | 1 << 14, 1500 | 2 << 14, 2000, 0 | 1 << 14, 16_383 | 2 << 14])
    }

    func testWrongPixelFormatOrSizeIsRejected() throws {
        let bgra = try pixelBuffer(2, 2, kCVPixelFormatType_32BGRA)
        let confidence = try pixelBuffer(2, 2, kCVPixelFormatType_OneComponent8)
        XCTAssertNil(RecordingFormat.packedDepthData(depth: bgra, confidence: confidence))
        let depth = try pixelBuffer(3, 2, kCVPixelFormatType_DepthFloat32)
        XCTAssertNil(RecordingFormat.packedDepthData(depth: depth, confidence: confidence))
    }
}

final class RetimeTests: XCTestCase {
    func testVideoTimeIsRelativeToFirstFrame() {
        let t0 = 12_345.678
        XCTAssertEqual(RecordingFormat.videoTime(t0, t0: t0), .zero)
        XCTAssertEqual(RecordingFormat.videoTime(t0 + 1.5, t0: t0).seconds, 1.5, accuracy: 1.0 / 600)
        XCTAssertEqual(RecordingFormat.videoTime(t0 + 1.5, t0: t0).timescale, 600)
    }

    private func depthFrames(fps: Double, jitter: Double = 0) -> [Int] {
        var last: TimeInterval?
        var sampled: [Int] = []
        for frame in 0..<Int(fps) {
            // Alternate early and late timestamps to mimic real frame jitter.
            let ts = 100 + Double(frame) / fps + (frame.isMultiple(of: 2) ? -jitter : jitter)
            if RecordingFormat.isDepthDue(at: ts, lastDepth: last) {
                sampled.append(frame)
                last = ts
            }
        }
        return sampled
    }

    func testDepthRunsAtTenHertzOnThirtyFps() {
        XCTAssertEqual(depthFrames(fps: 30), [0, 3, 6, 9, 12, 15, 18, 21, 24, 27])
        XCTAssertEqual(depthFrames(fps: 30, jitter: 0.001).count, 10)
    }

    /// The first real capture ran at 60 fps and logged depth at 12 Hz.
    func testDepthRunsAtTenHertzOnSixtyFps() {
        XCTAssertEqual(depthFrames(fps: 60), Array(Swift.stride(from: 0, to: 60, by: 6)))
        XCTAssertEqual(depthFrames(fps: 60, jitter: 0.001).count, 10)
    }
}

final class ManifestTests: XCTestCase {
    func testFrameLineMatchesTheContract() throws {
        var T = matrix_identity_float4x4
        T.columns.3 = SIMD4<Float>(1, 2, 3, 1)
        let line = FrameLine(
            index: 7, t: 0.25, cameraToWorld: T, intrinsics: SIMD4<Float>(1500, 1500, 960, 720),
            tracking: "normal", depthIndex: 2, phase: "moment")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.json().utf8)) as? [String: Any])

        XCTAssertEqual(json["i"] as? Int, 7)
        XCTAssertEqual(json["t"] as? Double, 0.25)
        XCTAssertEqual(json["d"] as? Int, 2)
        XCTAssertEqual(json["track"] as? String, "normal")
        XCTAssertEqual(json["phase"] as? String, "moment")
        XCTAssertEqual(json["K"] as? [Double], [1500, 1500, 960, 720])
        // Column-major: the translation is the last four values.
        let flat = try XCTUnwrap(json["T"] as? [Double])
        XCTAssertEqual(flat.count, 16)
        XCTAssertEqual(Array(flat[12...]), [1, 2, 3, 1])
    }

    func testScanLineHasNullVideoIndexAndNegativeTime() throws {
        let line = FrameLine(
            index: nil, t: -12.5, cameraToWorld: matrix_identity_float4x4, intrinsics: .zero,
            tracking: "limited", depthIndex: nil, phase: "scan")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.json().utf8)) as? [String: Any])
        XCTAssertTrue(json["i"] is NSNull)
        XCTAssertTrue(json["d"] is NSNull)
        XCTAssertEqual(json["t"] as? Double, -12.5)
    }

    func testManifestRoundTripsWithContractKeys() throws {
        let manifest = CaptureManifest(
            id: "abc", createdAt: "2026-10-24T18:30:00Z", device: "iPhone17,2", title: "", attendees: [],
            video: .init(width: 1920, height: 1440, fps: 30, durationSec: 61.2, frameCount: 1836),
            audio: .init(inVideo: true, sampleRate: 48_000, channels: 1),
            depth: .init(width: 256, height: 192, rateHz: 10, count: 612),
            room: .init(points: 1_834_221, voxelMeters: 0.01),
            phases: .init(scan: .init(tStart: -48.2, tEnd: -1), moment: .init(tStart: 0, tEnd: 61.2)),
            warnings: [])
        let data = try manifest.encoded()
        XCTAssertEqual(try JSONDecoder().decode(CaptureManifest.self, from: data), manifest)

        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["format"] as? String, "braindance.capture")
        XCTAssertEqual(json["version"] as? Int, 1)
        XCTAssertEqual(json["coordinates"] as? String, "arkit-world-meters-y-up")
        XCTAssertEqual(json["imageOrientation"] as? String, "landscapeRight")
        let depth = try XCTUnwrap(json["depth"] as? [String: Any])
        XCTAssertEqual(depth["file"] as? String, "depth.bin")
        XCTAssertEqual(depth["index"] as? String, "depth.index.json")
        XCTAssertEqual(depth["encoding"] as? String, "v2")
        XCTAssertNil(depth["confidenceFile"])
        XCTAssertEqual(depth["unit"] as? String, "mm")
        let room = try XCTUnwrap(json["room"] as? [String: Any])
        XCTAssertEqual(room["source"] as? String, "on-device")
        XCTAssertEqual(room["bin"] as? String, "room.bin")
        XCTAssertNil(room["ply"])   // not uploaded, so not listed
    }
}

final class KeyframeAndTranscriptTests: XCTestCase {
    /// Replays frame times through the live keyframe picker.
    private func keyframes(frameTimes: [Double]) -> [Int: Double] {
        var next = 0
        var picked: [Int: Double] = [:]
        for t in frameTimes {
            guard let seconds = RecordingFormat.keyframeSecondsDue(at: t, next: next) else { continue }
            for s in seconds { picked[s] = t }
            next = seconds.upperBound + 1
        }
        return picked
    }

    func testOneKeyframePerWholeSecondFromTheFirstFrameAtOrAfterIt() {
        // 28.434 s at 30 fps, frames at k/30 with a little jitter.
        let times = (0..<853).map { max(0, Double($0) / 30 + ($0.isMultiple(of: 2) ? 0.0004 : -0.0004)) }
        let picked = keyframes(frameTimes: times)
        XCTAssertEqual(picked.keys.sorted(), Array(0...28))
        for (second, t) in picked {
            XCTAssertGreaterThanOrEqual(t, Double(second))
            XCTAssertLessThan(t, Double(second) + 1.0 / 30 + 0.001)   // within one frame of the whole second
        }
        XCTAssertEqual(RecordingFormat.keyframeName(second: 12), "keyframes/k0012.jpg")
    }

    func testAGapLongerThanASecondLeavesNoMissingKeyframes() {
        let picked = keyframes(frameTimes: [0, 0.5, 0.97, 1.01, 1.5, 3.2, 3.9, 4.0])
        XCTAssertEqual(picked, [0: 0, 1: 1.01, 2: 3.2, 3: 3.2, 4: 4.0])
        XCTAssertNil(RecordingFormat.keyframeSecondsDue(at: 0.99, next: 1))
        XCTAssertNil(RecordingFormat.keyframeSecondsDue(at: .nan, next: 0))
    }

    func testKeyframesAreAtMost1024OnTheLongSide() {
        XCTAssertEqual(RecordingFormat.keyframeScale(width: 1920, height: 1440) * 1440, 768, accuracy: 0.001)
        XCTAssertEqual(RecordingFormat.keyframeScale(width: 1920, height: 1440) * 1920, 1024, accuracy: 0.001)
        XCTAssertEqual(RecordingFormat.keyframeScale(width: 640, height: 480), 1)
    }

    func testTranscriptSplitsOnPausesAndSentenceEnds() {
        let words = [
            TranscriptWord(start: 0.0, end: 0.3, word: "Hi"),
            TranscriptWord(start: 0.35, end: 0.6, word: "Mom."),
            TranscriptWord(start: 0.7, end: 1.0, word: "I"),
            TranscriptWord(start: 1.05, end: 1.4, word: "brought"),
            TranscriptWord(start: 1.45, end: 1.9, word: "cake"),
            TranscriptWord(start: 3.0, end: 3.3, word: "Lovely"),
        ]
        let segments = TranscriptBuilder.segments(from: words)
        XCTAssertEqual(segments.map(\.text), ["Hi Mom.", "I brought cake", "Lovely"])
        XCTAssertEqual(segments[1].start, 0.7)
        XCTAssertEqual(segments[1].end, 1.9)
        XCTAssertEqual(segments[1].words.count, 3)
        XCTAssertTrue(TranscriptBuilder.segments(from: []).isEmpty)
    }

    func testTranscriptFileMatchesTheContract() throws {
        let file = TranscriptFile(locale: "en-US", segments: TranscriptBuilder.segments(from: [
            TranscriptWord(start: 3.12, end: 3.3, word: "Mom"),
        ]))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try file.encoded()) as? [String: Any])
        XCTAssertEqual(json["locale"] as? String, "en-US")
        let segment = try XCTUnwrap((json["segments"] as? [[String: Any]])?.first)
        XCTAssertEqual(segment["text"] as? String, "Mom")
        XCTAssertEqual(segment["start"] as? Double, 3.12)
        let word = try XCTUnwrap((segment["words"] as? [[String: Any]])?.first)
        XCTAssertEqual(word["word"] as? String, "Mom")
    }

    func testManifestWritesTranscriptAndKeyframesOnlyWhenPresent() throws {
        var manifest = CaptureManifest(
            id: "abc", createdAt: "t", device: "d", title: "", attendees: [],
            video: .init(width: 1920, height: 1440, fps: 30, durationSec: 1, frameCount: 30),
            audio: .init(inVideo: true, sampleRate: 48_000, channels: 1),
            depth: .init(width: 256, height: 192, rateHz: 10, count: 10),
            phases: .init(moment: .init(tStart: 0, tEnd: 1)), warnings: [])
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: try manifest.encoded()) as? [String: Any])
        XCTAssertNil(json["transcript"])
        XCTAssertNil(json["keyframes"])
        XCTAssertEqual((json["video"] as? [String: Any])?["file"] as? String, "video.mp4")

        manifest.transcript = .init(locale: "en-US")
        manifest.keyframes = .init(count: 2)
        json = try XCTUnwrap(JSONSerialization.jsonObject(with: try manifest.encoded()) as? [String: Any])
        XCTAssertEqual((json["transcript"] as? [String: Any])?["file"] as? String, "transcript.json")
        XCTAssertEqual((json["keyframes"] as? [String: Any])?["dir"] as? String, "keyframes")
        XCTAssertEqual((json["keyframes"] as? [String: Any])?["count"] as? Int, 2)
    }
}
