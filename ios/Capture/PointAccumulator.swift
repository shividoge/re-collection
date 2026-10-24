import ARKit
import Metal
import simd

/// Builds the room's colored point cloud on the GPU (IOS_CAPTURE_PLAN.md 5.1-5.2).
///
/// Each accepted depth frame runs `unprojectKernel`, which turns every
/// `stride`-th high-confidence depth pixel into a world-space point colored
/// from the camera image, and appends it to `pointBuffer`. The renderer draws
/// straight from the same buffer.
///
/// `accumulate` and `reset` are called on the capture queue. `pointCount` can
/// be read from any thread; it may lag the GPU by a frame, which is fine for
/// drawing and the HUD.
final class PointAccumulator {
    /// 16 bytes per point: packed_float3 position + uchar4 color (Shaders.metal `CloudPoint`).
    static let bytesPerPoint = 16
    static let maxPoints = 4_000_000

    /// Depths outside this range (meters) are dropped as unreliable.
    static let depthRange = SIMD2<Float>(0.2, 4.5)

    let device: MTLDevice
    let pointBuffer: MTLBuffer

    /// Every `stride`-th depth pixel in each direction. 2 gives about 12k points
    /// per pass from a 256x192 map.
    var stride: UInt32 = 2

    private let counterBuffer: MTLBuffer
    private let commandQueue: MTLCommandQueue
    private let pipeline: MTLComputePipelineState
    private let textureCache: CVMetalTextureCache
    private var passesSinceFlush = 0

    init(device: MTLDevice) throws {
        guard let library = device.makeDefaultLibrary(),
              let function = library.makeFunction(name: "unprojectKernel")
        else { throw RendererError.setupFailed("no unproject kernel") }
        guard let queue = device.makeCommandQueue() else { throw RendererError.setupFailed("no compute queue") }
        // 64 MB. Shared storage so the exporter can read it back without a blit.
        guard let points = device.makeBuffer(length: Self.maxPoints * Self.bytesPerPoint, options: .storageModeShared),
              let counter = device.makeBuffer(length: MemoryLayout<UInt32>.size, options: .storageModeShared)
        else { throw RendererError.setupFailed("couldn't allocate the point buffer") }

        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) == kCVReturnSuccess, let cache else {
            throw RendererError.setupFailed("no texture cache")
        }

        do {
            pipeline = try device.makeComputePipelineState(function: function)
        } catch {
            throw RendererError.setupFailed("unproject pipeline: \(error.localizedDescription)")
        }

        self.device = device
        self.commandQueue = queue
        self.pointBuffer = points
        self.counterBuffer = counter
        self.textureCache = cache
        reset()
    }

    /// Number of points written so far, capped at `maxPoints`.
    var pointCount: Int {
        // The kernel's atomic counter keeps climbing past the cap (writes past
        // it are discarded), so clamp here.
        let raw = counterBuffer.contents().load(as: UInt32.self)
        return min(Int(raw), Self.maxPoints)
    }

    var isFull: Bool { pointCount >= Self.maxPoints }

    func reset() {
        counterBuffer.contents().storeBytes(of: UInt32(0), as: UInt32.self)
    }

    /// Encodes one accumulation pass for this frame's depth. Returns false if
    /// the textures couldn't be made, so the caller can retry on the next frame.
    func accumulate(
        depthMap: CVPixelBuffer,
        confidenceMap: CVPixelBuffer,
        capturedImage: CVPixelBuffer,
        cameraIntrinsics K: simd_float3x3,
        imageResolution: CGSize,
        cameraToWorld: simd_float4x4
    ) -> Bool {
        let depthWidth = CVPixelBufferGetWidth(depthMap)
        let depthHeight = CVPixelBufferGetHeight(depthMap)

        guard CVPixelBufferGetPlaneCount(capturedImage) >= 2,
              let depth = makeTexture(depthMap, format: .r32Float, plane: 0),
              let confidence = makeTexture(confidenceMap, format: .r8Uint, plane: 0),
              let luma = makeTexture(capturedImage, format: .r8Unorm, plane: 0),
              let chroma = makeTexture(capturedImage, format: .rg8Unorm, plane: 1),
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeComputeCommandEncoder()
        else { return false }

        var uniforms = AccumulateUniforms(
            cameraToWorld: cameraToWorld,
            intrinsics: CameraMath.depthIntrinsics(
                from: K,
                imageWidth: Float(imageResolution.width), imageHeight: Float(imageResolution.height),
                depthWidth: Float(depthWidth), depthHeight: Float(depthHeight)),
            depthRange: Self.depthRange,
            stride: stride,
            maxPoints: UInt32(Self.maxPoints))

        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(CVMetalTextureGetTexture(depth), index: 0)
        encoder.setTexture(CVMetalTextureGetTexture(confidence), index: 1)
        encoder.setTexture(CVMetalTextureGetTexture(luma), index: 2)
        encoder.setTexture(CVMetalTextureGetTexture(chroma), index: 3)
        encoder.setBytes(&uniforms, length: MemoryLayout<AccumulateUniforms>.stride, index: 0)
        encoder.setBuffer(pointBuffer, offset: 0, index: 1)
        encoder.setBuffer(counterBuffer, offset: 0, index: 2)

        let s = Int(stride)
        let grid = MTLSize(width: (depthWidth + s - 1) / s, height: (depthHeight + s - 1) / s, depth: 1)
        let group = MTLSize(width: 16, height: 16, depth: 1)
        encoder.dispatchThreads(grid, threadsPerThreadgroup: group)
        encoder.endEncoding()

        // Keep the CVMetalTextures (and the pixel buffers behind them) alive
        // until the GPU is done. These hold pixel buffers, never the ARFrame.
        let inFlight = [depth, confidence, luma, chroma]
        commandBuffer.addCompletedHandler { _ in withExtendedLifetime(inFlight) {} }
        commandBuffer.commit()

        passesSinceFlush += 1
        if passesSinceFlush >= 30 {
            CVMetalTextureCacheFlush(textureCache, 0)
            passesSinceFlush = 0
        }
        return true
    }

    private func makeTexture(_ pixelBuffer: CVPixelBuffer, format: MTLPixelFormat, plane: Int) -> CVMetalTexture? {
        let planar = CVPixelBufferGetPlaneCount(pixelBuffer) > 0
        let width = planar ? CVPixelBufferGetWidthOfPlane(pixelBuffer, plane) : CVPixelBufferGetWidth(pixelBuffer)
        let height = planar ? CVPixelBufferGetHeightOfPlane(pixelBuffer, plane) : CVPixelBufferGetHeight(pixelBuffer)
        var texture: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            nil, textureCache, pixelBuffer, nil, format, width, height, plane, &texture)
        return status == kCVReturnSuccess ? texture : nil
    }
}

/// Mirrors `AccumulateUniforms` in Shaders.metal field for field (96 bytes).
struct AccumulateUniforms {
    var cameraToWorld: simd_float4x4
    var intrinsics: SIMD4<Float>   // fx, fy, cx, cy at depth resolution
    var depthRange: SIMD2<Float>   // min, max meters
    var stride: UInt32
    var maxPoints: UInt32
}
