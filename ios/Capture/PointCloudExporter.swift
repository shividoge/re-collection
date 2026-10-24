import Foundation
import simd

/// Swift view of one point in the GPU buffer. Must match `CloudPoint` in
/// Shaders.metal: packed_float3 position + uchar4 color, 16 bytes.
struct CloudPoint {
    var x: Float, y: Float, z: Float
    var r: UInt8, g: UInt8, b: UInt8, a: UInt8
}

struct ExportPoint: Equatable {
    var position: SIMD3<Float>
    var color: SIMD3<UInt8>
}

/// Running sum of the points that fell into one voxel.
private struct VoxelSum {
    var position = SIMD3<Double>.zero
    var color = SIMD3<UInt32>.zero
    var count: UInt32 = 0

    mutating func add(_ p: CloudPoint) {
        position += SIMD3<Double>(Double(p.x), Double(p.y), Double(p.z))
        color &+= SIMD3<UInt32>(UInt32(p.r), UInt32(p.g), UInt32(p.b))
        count += 1
    }
}

/// Turns the raw accumulated cloud into the files in IOS_CAPTURE_PLAN.md 7:
/// a 1 cm voxel-downsampled `room.ply` and the web's compact `room.bin`.
enum PointCloudExporter {
    static let voxelMeters: Float = 0.01

    /// Merges every point that falls in the same `voxel`-sized cube into one
    /// point at their mean position with their mean color. Output order is
    /// arbitrary.
    static func downsample<C: Collection>(_ points: C, voxel: Float = voxelMeters) -> [ExportPoint]
    where C.Element == CloudPoint {
        var voxels: [Int64: VoxelSum] = [:]
        voxels.reserveCapacity(points.count / 2)

        for p in points {
            guard p.x.isFinite, p.y.isFinite, p.z.isFinite else { continue }
            voxels[voxelKey(x: p.x, y: p.y, z: p.z, voxel: voxel), default: VoxelSum()].add(p)
        }

        return voxels.values.map { sum in
            let n = Double(sum.count)
            let mean = sum.position / n
            // Round to nearest when averaging colors.
            let half = sum.count / 2
            let color = (sum.color &+ SIMD3<UInt32>(repeating: half)) / SIMD3<UInt32>(repeating: sum.count)
            return ExportPoint(
                position: SIMD3<Float>(Float(mean.x), Float(mean.y), Float(mean.z)),
                color: SIMD3<UInt8>(UInt8(color.x), UInt8(color.y), UInt8(color.z)))
        }
    }

    /// Packs floored voxel coordinates into 21 bits each (about ±10 km at 1 cm).
    static func voxelKey(x: Float, y: Float, z: Float, voxel: Float) -> Int64 {
        func cell(_ v: Float) -> Int64 {
            let i = Int64((v / voxel).rounded(.down))
            return i & 0x1F_FFFF
        }
        return cell(x) | (cell(y) << 21) | (cell(z) << 42)
    }

    /// Binary little-endian PLY: float x y z, uchar red green blue (15 bytes per vertex).
    static func plyData(_ points: [ExportPoint]) -> Data {
        let header = """
            ply
            format binary_little_endian 1.0
            comment Braindance room scan, ARKit world meters, y up
            element vertex \(points.count)
            property float x
            property float y
            property float z
            property uchar red
            property uchar green
            property uchar blue
            end_header

            """
        var data = Data(header.utf8)
        data.reserveCapacity(data.count + points.count * 15)
        for p in points {
            appendLittleEndian(p.position.x, to: &data)
            appendLittleEndian(p.position.y, to: &data)
            appendLittleEndian(p.position.z, to: &data)
            data.append(contentsOf: [p.color.x, p.color.y, p.color.z])
        }
        return data
    }

    /// The web's compact format: UInt32 count, then float32 xyz for all points,
    /// then uint8 rgb for all points. Little-endian.
    static func roomBinData(_ points: [ExportPoint]) -> Data {
        var data = Data()
        data.reserveCapacity(4 + points.count * 15)
        var count = UInt32(points.count).littleEndian
        withUnsafeBytes(of: &count) { data.append(contentsOf: $0) }
        for p in points {
            appendLittleEndian(p.position.x, to: &data)
            appendLittleEndian(p.position.y, to: &data)
            appendLittleEndian(p.position.z, to: &data)
        }
        for p in points {
            data.append(contentsOf: [p.color.x, p.color.y, p.color.z])
        }
        return data
    }

    private static func appendLittleEndian(_ value: Float, to data: inout Data) {
        var bits = value.bitPattern.littleEndian
        withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
    }
}
