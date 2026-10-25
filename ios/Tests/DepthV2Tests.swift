import Foundation
import XCTest
@testable import BraindanceCapture

final class DepthV2Tests: XCTestCase {
    func testPixelPackingMatchesTheContract() {
        XCTAssertEqual(DepthV2.pack(millimeters: 0, confidence: 0), 0)
        XCTAssertEqual(DepthV2.pack(millimeters: 1234, confidence: 1), 1234 | 1 << 14)
        XCTAssertEqual(DepthV2.pack(millimeters: 1234, confidence: 2), 1234 | 2 << 14)
        XCTAssertEqual(DepthV2.pack(millimeters: 16_383, confidence: 2), 0xBFFF)
        // Too far clamps to the 14-bit maximum instead of spilling into the confidence bits.
        XCTAssertEqual(DepthV2.pack(millimeters: 20_000, confidence: 0), 16_383)
        XCTAssertEqual(DepthV2.pack(millimeters: 65_535, confidence: 1), 16_383 | 1 << 14)
        XCTAssertEqual(DepthV2.pack(millimeters: 10, confidence: 9), 10 | 3 << 14)
    }

    /// Made with Python's `zlib.compressobj(9, zlib.DEFLATED, -15)`, the same
    /// raw DEFLATE that Node's `deflateRawSync` and the browser's
    /// `CompressionStream('deflate-raw')` write. If COMPRESSION_ZLIB expected a
    /// zlib header, this would fail.
    func testInflatesRawDeflateMadeElsewhere() throws {
        let compressed = Data([0x63, 0x60, 0xb8, 0xe4, 0xf2, 0x7f, 0xff, 0x17, 0x46, 0x06, 0x32, 0x69, 0x00])
        let values: [UInt16] = Array(repeating: [0, 1234 | 1 << 14, 16_383 | 2 << 14, 500], count: 8).flatMap { $0 }
        let raw = try XCTUnwrap(DepthV2.inflate(compressed, size: values.count * 2))
        XCTAssertEqual(Self.uint16s(raw), values)
    }

    func testDeflateRoundTripsAndHasNoZlibHeader() throws {
        let raw = Data((0..<98_304).map { UInt8(truncatingIfNeeded: $0 / 7) })
        let compressed = try XCTUnwrap(DepthV2.deflate(raw))
        XCTAssertLessThan(compressed.count, raw.count)
        // A zlib stream would start 0x78 (CMF) with (CMF·256 + FLG) divisible by 31.
        let header = Int(compressed[0]) << 8 | Int(compressed[1])
        XCTAssertFalse(compressed[0] == 0x78 && header % 31 == 0)
        XCTAssertEqual(DepthV2.inflate(compressed, size: raw.count), raw)
        XCTAssertNil(DepthV2.inflate(compressed, size: raw.count - 1))   // exact size only
        XCTAssertNil(DepthV2.inflate(compressed, size: raw.count + 1))
    }

    func testChunksOfTenFramesWithAnIndex() throws {
        var file = Data()
        let writer = DepthChunkWriter(width: 4, height: 3) { file.append($0) }
        let frames = (0..<23).map { k in Self.frame(width: 4, height: 3, seed: k) }
        for frame in frames { try writer.append(frame) }
        let index = try writer.finish()

        XCTAssertEqual(index.format, "braindance.depth")
        XCTAssertEqual(index.version, 2)
        XCTAssertEqual(index.width, 4)
        XCTAssertEqual(index.height, 3)
        XCTAssertEqual(index.count, 23)
        XCTAssertEqual(index.framesPerChunk, 10)
        XCTAssertEqual(index.chunks.count, 3)   // 10 + 10 + 3
        XCTAssertEqual(index.chunks[0][0], 0)
        for c in 1..<index.chunks.count {
            XCTAssertEqual(index.chunks[c][0], index.chunks[c - 1][0] + index.chunks[c - 1][1])
        }
        XCTAssertEqual(index.chunks.last.map { $0[0] + $0[1] }, file.count)

        // Decoding chunk by chunk gives the frames back in order.
        var decoded = Data()
        for (c, chunk) in index.chunks.enumerated() {
            let n = min(index.framesPerChunk, index.count - c * index.framesPerChunk)
            let bytes = file.subdata(in: chunk[0]..<(chunk[0] + chunk[1]))
            decoded.append(try XCTUnwrap(DepthV2.inflate(bytes, size: n * 4 * 3 * 2)))
        }
        XCTAssertEqual(decoded, frames.reduce(Data(), +))
    }

    func testNoFramesGivesAnEmptyIndex() throws {
        var file = Data()
        let writer = DepthChunkWriter(width: 256, height: 192) { file.append($0) }
        let index = try writer.finish()
        XCTAssertEqual(index.count, 0)
        XCTAssertEqual(index.chunks, [])
        XCTAssertTrue(file.isEmpty)
    }

    func testWrongFrameSizeIsRejected() {
        let writer = DepthChunkWriter(width: 4, height: 3) { _ in }
        XCTAssertThrowsError(try writer.append(Data(count: 10)))
    }

    func testIndexJSONMatchesTheContract() throws {
        let index = DepthIndex(width: 256, height: 192, count: 12, framesPerChunk: 10, chunks: [[0, 41_234], [41_234, 9_876]])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try index.encoded()) as? [String: Any])
        XCTAssertEqual(json["format"] as? String, "braindance.depth")
        XCTAssertEqual(json["version"] as? Int, 2)
        XCTAssertEqual(json["count"] as? Int, 12)
        XCTAssertEqual(json["framesPerChunk"] as? Int, 10)
        XCTAssertEqual(json["chunks"] as? [[Int]], [[0, 41_234], [41_234, 9_876]])
    }

    private static func frame(width: Int, height: Int, seed: Int) -> Data {
        var data = Data()
        for p in 0..<(width * height) {
            let value = DepthV2.pack(millimeters: UInt16((seed * 97 + p * 13) % 5000), confidence: UInt8(p % 3)).littleEndian
            withUnsafeBytes(of: value) { data.append(contentsOf: $0) }
        }
        return data
    }

    private static func uint16s(_ data: Data) -> [UInt16] {
        let bytes = [UInt8](data)
        return Swift.stride(from: 0, to: bytes.count, by: 2).map { UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8 }
    }
}
