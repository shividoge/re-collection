import Compression
import Foundation

/// Depth v2 (docs/architecture-v3.md §3): every pixel is a little-endian
/// UInt16 `(mm & 0x3FFF) | confidence << 14`, and frames are grouped ten to a
/// chunk, each chunk compressed with raw DEFLATE. depth.bin is the chunks back
/// to back; depth.index.json says where each one starts.
enum DepthV2 {
    static let maxMillimeters: UInt16 = 0x3FFF
    static let framesPerChunk = 10

    /// One packed pixel. Millimeters above 16,383 are clamped (LiDAR tops out
    /// around 5 m); confidence is 0 low, 1 medium, 2 high.
    static func pack(millimeters: UInt16, confidence: UInt8) -> UInt16 {
        min(millimeters, maxMillimeters) | UInt16(min(confidence, 3)) << 14
    }

    /// Raw DEFLATE (RFC 1951, no zlib header or checksum). That's exactly what
    /// Apple's COMPRESSION_ZLIB writes, and what the web's
    /// `DecompressionStream('deflate-raw')` and Node's `inflateRawSync` read.
    static func deflate(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        // Stored blocks cost 5 bytes per 64 KB, so this always fits.
        let capacity = data.count + data.count / 16 + 1024
        var out = Data(count: capacity)
        let written = out.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) -> Int in
            data.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Int in
                guard let d = dst.bindMemory(to: UInt8.self).baseAddress,
                      let s = src.bindMemory(to: UInt8.self).baseAddress
                else { return 0 }
                return compression_encode_buffer(d, capacity, s, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written > 0 else { return nil }
        out.count = written
        return out
    }

    /// Inverse of `deflate`. Nil unless it inflates to exactly `size` bytes.
    static func inflate(_ data: Data, size: Int) -> Data? {
        guard !data.isEmpty, size > 0 else { return nil }
        // One spare byte tells "exactly size" apart from "at least size".
        var out = Data(count: size + 1)
        let written = out.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) -> Int in
            data.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Int in
                guard let d = dst.bindMemory(to: UInt8.self).baseAddress,
                      let s = src.bindMemory(to: UInt8.self).baseAddress
                else { return 0 }
                return compression_decode_buffer(d, size + 1, s, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written == size else { return nil }
        out.count = size
        return out
    }
}

/// depth.index.json. `chunks[c]` is `[byteOffset, byteLength]` in depth.bin.
struct DepthIndex: Codable, Equatable {
    var format = "braindance.depth"
    var version = 2
    var width: Int
    var height: Int
    var count: Int
    var framesPerChunk: Int
    var chunks: [[Int]]

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
}

/// Collects packed depth frames and writes one compressed chunk every
/// `framesPerChunk` frames. Not thread-safe: the recorder uses it only on its
/// file queue, so compression never blocks the camera.
final class DepthChunkWriter {
    let width: Int
    let height: Int
    let framesPerChunk: Int
    private let write: (Data) throws -> Void
    private var pending = Data()
    private var pendingFrames = 0
    private var count = 0
    private var offset = 0
    private var chunks: [[Int]] = []

    init(width: Int, height: Int, framesPerChunk: Int = DepthV2.framesPerChunk, write: @escaping (Data) throws -> Void) {
        self.width = width
        self.height = height
        self.framesPerChunk = framesPerChunk
        self.write = write
    }

    var frameBytes: Int { width * height * 2 }

    /// Adds one packed frame (`width × height` UInt16, little-endian).
    func append(_ frame: Data) throws {
        guard frame.count == frameBytes else { throw DepthWriteError.wrongFrameSize(frame.count, expected: frameBytes) }
        if pending.isEmpty { pending.reserveCapacity(frameBytes * framesPerChunk) }
        pending.append(frame)
        pendingFrames += 1
        count += 1
        if pendingFrames == framesPerChunk { try flush() }
    }

    /// Writes the last, possibly shorter, chunk and returns the index.
    func finish() throws -> DepthIndex {
        try flush()
        return DepthIndex(width: width, height: height, count: count, framesPerChunk: framesPerChunk, chunks: chunks)
    }

    private func flush() throws {
        guard pendingFrames > 0 else { return }
        guard let compressed = DepthV2.deflate(pending) else { throw DepthWriteError.compressionFailed }
        try write(compressed)
        chunks.append([offset, compressed.count])
        offset += compressed.count
        pending.removeAll(keepingCapacity: true)
        pendingFrames = 0
    }
}

enum DepthWriteError: LocalizedError {
    case wrongFrameSize(Int, expected: Int)
    case compressionFailed

    var errorDescription: String? {
        switch self {
        case .wrongFrameSize(let got, let expected): return "a depth frame had \(got) bytes instead of \(expected)"
        case .compressionFailed: return "depth compression failed"
        }
    }
}
