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

    func testDepthBufferBecomesRowMajorLittleEndianMillimeters() throws {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, 3, 2, kCVPixelFormatType_DepthFloat32, nil, &buffer), kCVReturnSuccess)
        let depth = try XCTUnwrap(buffer)

        CVPixelBufferLockBaseAddress(depth, [])
        let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(depth))
        let bytesPerRow = CVPixelBufferGetBytesPerRow(depth)
        let values: [[Float]] = [[0.5, 1.0, 1.5], [2.0, .nan, 4.5]]
        for (row, rowValues) in values.enumerated() {
            let p = (base + row * bytesPerRow).assumingMemoryBound(to: Float32.self)
            for (col, v) in rowValues.enumerated() { p[col] = v }
        }
        CVPixelBufferUnlockBaseAddress(depth, [])

        let data = try XCTUnwrap(RecordingFormat.millimeterData(fromDepth: depth))
        XCTAssertEqual(data.count, 3 * 2 * 2)   // row padding dropped
        let bytes = [UInt8](data)
        let mm = Swift.stride(from: 0, to: bytes.count, by: 2).map { UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8 }
        XCTAssertEqual(mm, [500, 1000, 1500, 2000, 0, 4500])
    }

    func testConfidenceBufferIsCopiedWithoutPadding() throws {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, 3, 2, kCVPixelFormatType_OneComponent8, nil, &buffer), kCVReturnSuccess)
        let confidence = try XCTUnwrap(buffer)

        CVPixelBufferLockBaseAddress(confidence, [])
        let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(confidence))
        let bytesPerRow = CVPixelBufferGetBytesPerRow(confidence)
        for row in 0..<2 {
            let p = (base + row * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for col in 0..<3 { p[col] = UInt8((row * 3 + col) % 3) }
        }
        CVPixelBufferUnlockBaseAddress(confidence, [])

        let data = try XCTUnwrap(RecordingFormat.confidenceData(from: confidence))
        XCTAssertEqual([UInt8](data), [0, 1, 2, 0, 1, 2])
    }

    func testWrongPixelFormatIsRejected() throws {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, 2, 2, kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
        XCTAssertNil(RecordingFormat.millimeterData(fromDepth: try XCTUnwrap(buffer)))
    }
}

final class RetimeTests: XCTestCase {
    func testVideoTimeIsRelativeToFirstFrame() {
        let t0 = 12_345.678
        XCTAssertEqual(RecordingFormat.videoTime(t0, t0: t0), .zero)
        XCTAssertEqual(RecordingFormat.videoTime(t0 + 1.5, t0: t0).seconds, 1.5, accuracy: 1.0 / 600)
        XCTAssertEqual(RecordingFormat.videoTime(t0 + 1.5, t0: t0).timescale, 600)
    }

    func testDepthRunsAtTenHertzOnThirtyFps() {
        var last: TimeInterval?
        var sampled: [Int] = []
        for frame in 0..<30 {
            let ts = 100 + Double(frame) / 30
            if RecordingFormat.isDepthDue(at: ts, lastDepth: last) {
                sampled.append(frame)
                last = ts
            }
        }
        XCTAssertEqual(sampled, [0, 3, 6, 9, 12, 15, 18, 21, 24, 27])
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
        XCTAssertEqual(depth["confidenceFile"] as? String, "confidence.bin")
        XCTAssertEqual(depth["unit"] as? String, "mm")
        let room = try XCTUnwrap(json["room"] as? [String: Any])
        XCTAssertEqual(room["source"] as? String, "on-device")
        XCTAssertEqual(room["bin"] as? String, "room.bin")
    }
}
