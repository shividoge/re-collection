import ARKit
import MetalKit

enum RendererError: LocalizedError {
    case setupFailed(String)

    var errorDescription: String? {
        switch self {
        case .setupFailed(let detail): return "The camera preview couldn't start (\(detail))."
        }
    }
}

/// Draws the live camera image into an MTKView. MTKView calls `draw(in:)` on
/// the main thread at up to 60 fps; ARKit delivers new images at 30 fps, so
/// every other draw repeats the latest image.
final class Renderer: NSObject, MTKViewDelegate {
    /// Main thread. Draws per second, reported twice a second.
    var onFPS: ((Double) -> Void)?

    private let session: ARSession
    private let commandQueue: MTLCommandQueue
    private let cameraPipeline: MTLRenderPipelineState
    private let textureCache: CVMetalTextureCache

    private var drawsInWindow = 0
    private var windowStart = CACurrentMediaTime()

    init(view: MTKView, session: ARSession) throws {
        guard let device = view.device else { throw RendererError.setupFailed("no Metal device") }
        guard let queue = device.makeCommandQueue() else { throw RendererError.setupFailed("no command queue") }
        guard let library = device.makeDefaultLibrary() else { throw RendererError.setupFailed("no shader library") }

        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) == kCVReturnSuccess, let cache else {
            throw RendererError.setupFailed("no texture cache")
        }

        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "cameraVertex")
        descriptor.fragmentFunction = library.makeFunction(name: "cameraFragment")
        descriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
        do {
            cameraPipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            throw RendererError.setupFailed("camera pipeline: \(error.localizedDescription)")
        }

        self.session = session
        self.commandQueue = queue
        self.textureCache = cache
        super.init()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        countDraw()

        let viewSize = view.bounds.size
        guard viewSize.width > 0, viewSize.height > 0,
              let frame = session.currentFrame,
              let passDescriptor = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let commandBuffer = commandQueue.makeCommandBuffer()
        else { return }

        // capturedImage is bi-planar 420YpCbCr8 full range: plane 0 = Y, plane 1 = CbCr.
        let pixelBuffer = frame.capturedImage
        guard CVPixelBufferGetPlaneCount(pixelBuffer) >= 2,
              let lumaTexture = makeTexture(from: pixelBuffer, format: .r8Unorm, plane: 0),
              let chromaTexture = makeTexture(from: pixelBuffer, format: .rg8Unorm, plane: 1),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: passDescriptor)
        else { return }

        let orientation = view.window?.windowScene?.interfaceOrientation ?? .portrait
        var texCoords = Self.cameraTexCoords(for: frame, orientation: orientation, viewSize: viewSize)

        encoder.setRenderPipelineState(cameraPipeline)
        encoder.setVertexBytes(&texCoords, length: MemoryLayout<SIMD2<Float>>.stride * texCoords.count, index: 0)
        encoder.setFragmentTexture(CVMetalTextureGetTexture(lumaTexture), index: 0)
        encoder.setFragmentTexture(CVMetalTextureGetTexture(chromaTexture), index: 1)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()

        // The CVMetalTextures (and the pixel buffer behind them) must stay alive
        // until the GPU has finished reading them.
        let inFlight = [lumaTexture, chromaTexture]
        commandBuffer.addCompletedHandler { _ in withExtendedLifetime(inFlight) {} }
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    /// Texture coordinates for the full-screen quad's four corners, in the
    /// triangle-strip order the vertex shader uses: bottom-left, bottom-right,
    /// top-left, top-right.
    ///
    /// `displayTransform` maps normalized image coordinates (the sensor's
    /// landscape orientation, origin top-left) to normalized view coordinates
    /// and includes the aspect-fill crop. We need the reverse, view corner ->
    /// image coordinate, so we invert it. The stored image is never rotated.
    private static func cameraTexCoords(
        for frame: ARFrame,
        orientation: UIInterfaceOrientation,
        viewSize: CGSize
    ) -> [SIMD2<Float>] {
        let viewToImage = frame.displayTransform(for: orientation, viewportSize: viewSize).inverted()
        let viewCorners = [CGPoint(x: 0, y: 1), CGPoint(x: 1, y: 1), CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 0)]
        return viewCorners.map { corner in
            let p = corner.applying(viewToImage)
            return SIMD2<Float>(Float(p.x), Float(p.y))
        }
    }

    private func makeTexture(from pixelBuffer: CVPixelBuffer, format: MTLPixelFormat, plane: Int) -> CVMetalTexture? {
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, plane)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)
        var texture: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            nil, textureCache, pixelBuffer, nil, format, width, height, plane, &texture)
        return status == kCVReturnSuccess ? texture : nil
    }

    private func countDraw() {
        drawsInWindow += 1
        let now = CACurrentMediaTime()
        let elapsed = now - windowStart
        guard elapsed >= 0.5 else { return }
        onFPS?(Double(drawsInWindow) / elapsed)
        drawsInWindow = 0
        windowStart = now
        CVMetalTextureCacheFlush(textureCache, 0)
    }
}
