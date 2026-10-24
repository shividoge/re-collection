import ARKit

/// Owns the single ARSession that the whole capture runs in (scan and moment
/// share one world frame, so the session never resets between phases).
///
/// Delegate callbacks arrive on `captureQueue`, never main. The renderer pulls
/// `session.currentFrame` on its own; nothing here stores ARFrames.
final class CaptureEngine: NSObject, ARSessionDelegate {
    enum Event {
        case tracking(String?)
        case pointCount(Int)
        case roomCaptured
        case failed(String)
    }

    let session = ARSession()

    /// Nil when Metal setup failed; `start` then refuses to scan.
    let accumulator: PointAccumulator?

    /// Called on `captureQueue` with the token of the capture that produced the event.
    var onEvent: ((UUID, Event) -> Void)?

    private let captureQueue = DispatchQueue(label: "braindance.capture", qos: .userInteractive)

    // Only read and written on `captureQueue`.
    private var token: UUID?
    private var isAccumulating = false
    private var lastAccumulatedPose: simd_float4x4?
    private var lastCountReport: TimeInterval = 0

    init(accumulator: PointAccumulator?) {
        self.accumulator = accumulator
        super.init()
        session.delegate = self
        session.delegateQueue = captureQueue
    }

    func start(token: UUID) {
        captureQueue.async {
            self.token = token
            self.isAccumulating = true
            self.lastAccumulatedPose = nil
            self.lastCountReport = 0
            self.accumulator?.reset()
        }

        let config = ARWorldTrackingConfiguration()
        config.frameSemantics = [.smoothedSceneDepth]   // less flicker than .sceneDepth
        config.sceneReconstruction = []                  // our point cloud replaces the mesh
        config.environmentTexturing = .none
        config.planeDetection = []
        // Keep the default 1920x1440 @ 30 fps format: same 4:3 aspect as the
        // 256x192 depth map, so image and depth pixels map by a straight scale.
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    /// Stops adding points but keeps the session (and its world frame)
    /// running. `then` runs on the capture queue once no new pass can start.
    func pauseAccumulation(then: @escaping () -> Void) {
        captureQueue.async {
            self.isAccumulating = false
            then()
        }
    }

    func stop() {
        session.pause()
        captureQueue.async {
            self.token = nil
            self.isAccumulating = false
        }
    }

    private func emit(_ event: Event) {
        guard let token else { return }
        onEvent?(token, event)
    }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard token != nil, isAccumulating, let accumulator else { return }

        // Limited tracking means the pose is unreliable; points would land in
        // the wrong place and never come out again.
        guard case .normal = frame.camera.trackingState else { return }

        let pose = frame.camera.transform
        if let last = lastAccumulatedPose, !PoseDelta.movedEnough(from: last, to: pose) { return }

        guard let depth = frame.smoothedSceneDepth, let confidence = depth.confidenceMap else { return }

        // Pass the pixel buffers and values, never the frame itself.
        let encoded = accumulator.accumulate(
            depthMap: depth.depthMap,
            confidenceMap: confidence,
            capturedImage: frame.capturedImage,
            cameraIntrinsics: frame.camera.intrinsics,
            imageResolution: frame.camera.imageResolution,
            cameraToWorld: pose)
        if encoded { lastAccumulatedPose = pose }

        if frame.timestamp - lastCountReport >= 0.25 {
            lastCountReport = frame.timestamp
            emit(.pointCount(accumulator.pointCount))
        }
        if accumulator.isFull {
            isAccumulating = false
            emit(.pointCount(accumulator.pointCount))
            emit(.roomCaptured)
        }
    }

    // MARK: ARSessionObserver

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        emit(.tracking(Self.guidance(for: camera.trackingState)))
    }

    func sessionWasInterrupted(_ session: ARSession) {
        emit(.failed("The camera was interrupted, so the capture stopped. Start again when you're ready."))
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        let message: String
        if let arError = error as? ARError, arError.code == .cameraUnauthorized {
            message = "Braindance needs camera access. Turn it on in Settings > Braindance, then try again."
        } else {
            message = "The capture stopped: \(error.localizedDescription)"
        }
        emit(.failed(message))
    }

    private static func guidance(for state: ARCamera.TrackingState) -> String? {
        switch state {
        case .normal:
            return nil
        case .notAvailable:
            return "Tracking isn't available yet"
        case .limited(.initializing):
            return "Hold steady for a moment"
        case .limited(.insufficientFeatures):
            return "Point at something with more detail"
        case .limited(.relocalizing):
            return "Finding your place again"
        case .limited:
            return "Move slowly"
        }
    }
}
