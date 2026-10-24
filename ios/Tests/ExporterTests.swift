import simd
import XCTest
@testable import BraindanceCapture

final class ExporterTests: XCTestCase {
    private func point(_ x: Float, _ y: Float, _ z: Float, _ r: UInt8, _ g: UInt8, _ b: UInt8) -> CloudPoint {
        CloudPoint(x: x, y: y, z: z, r: r, g: g, b: b, a: 255)
    }

    func testCloudPointMatchesGPULayout() {
        XCTAssertEqual(MemoryLayout<CloudPoint>.stride, PointAccumulator.bytesPerPoint)
        XCTAssertEqual(MemoryLayout<CloudPoint>.offset(of: \.r), 12)
    }

    func testPointsInOneVoxelMergeToTheirMean() {
        let merged = PointCloudExporter.downsample([
            point(0.001, 0.001, 0.001, 100, 0, 0),
            point(0.009, 0.009, 0.009, 200, 50, 0),
        ])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].position.x, 0.005, accuracy: 1e-6)
        XCTAssertEqual(merged[0].color, SIMD3<UInt8>(150, 25, 0))
    }

    func testPointsInNeighboringVoxelsStaySeparate() {
        let merged = PointCloudExporter.downsample([
            point(0.005, 0, 0, 0, 0, 0),
            point(0.015, 0, 0, 0, 0, 0),
            point(-0.005, 0, 0, 0, 0, 0),   // negative side of the origin is its own cell
        ])
        XCTAssertEqual(merged.count, 3)
    }

    func testNonFinitePointsAreDropped() {
        XCTAssertTrue(PointCloudExporter.downsample([point(.nan, 0, 0, 0, 0, 0)]).isEmpty)
    }

    func testRoomBinLayout() {
        let points = [
            ExportPoint(position: SIMD3<Float>(1, 2, 3), color: SIMD3<UInt8>(10, 20, 30)),
            ExportPoint(position: SIMD3<Float>(4, 5, 6), color: SIMD3<UInt8>(40, 50, 60)),
        ]
        let data = PointCloudExporter.roomBinData(points)
        XCTAssertEqual(data.count, 4 + 2 * 12 + 2 * 3)

        let bytes = [UInt8](data)
        let count = UInt32(bytes[0]) | UInt32(bytes[1]) << 8 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 24
        XCTAssertEqual(count, 2)

        func float(at offset: Int) -> Float {
            let bits = UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8
                | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24
            return Float(bitPattern: bits)
        }
        // All xyz first, then all rgb.
        XCTAssertEqual(float(at: 4), 1)
        XCTAssertEqual(float(at: 4 + 5 * 4), 6)
        XCTAssertEqual(Array(bytes[28...]), [10, 20, 30, 40, 50, 60])
    }

    func testPLYHeaderAndBodySize() {
        let points = [ExportPoint(position: SIMD3<Float>(1, 2, 3), color: SIMD3<UInt8>(10, 20, 30))]
        let data = PointCloudExporter.plyData(points)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("ply\nformat binary_little_endian 1.0\n"))
        XCTAssertTrue(text.contains("element vertex 1\n"))

        let headerEnd = "end_header\n"
        let range = data.range(of: Data(headerEnd.utf8))!
        XCTAssertEqual(data.count - range.upperBound, 15)
        XCTAssertEqual(Array(data.suffix(3)), [10, 20, 30])
    }
}
