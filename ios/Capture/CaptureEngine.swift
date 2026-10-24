import ARKit

/// Owns the single ARSession that the whole capture runs in (scan and moment
/// share one world frame, so the session never resets between phases).
///
/// Delegate callbacks arrive on `captureQueue`, never main. The renderer pulls
/// `session.currentFrame` on its own; nothing here stores ARFrames.
final class CaptureEngine: NSObject, ARSessionDelegate {
    enum Event {
        case tracking(String?)
        case failed(String)
    }

    let session = ARSession()

    /// Called on `captureQueue` with the token of the capture that produced the event.
    var onEvent: ((UUID, Event) -> Void)?

    private let captureQueue = DispatchQueue(label: "braindance.capture", qos: .userInteractive)

    /// Only read and written on `captureQueue`.
    private var token: UUID?

    override init() {
        super.init()
        session.delegate = self
        session.delegateQueue = captureQueue
    }

    func start(token: UUID) {
        captureQueue.async { self.token = token }

        let config = ARWorldTrackingConfiguration()
        config.frameSemantics = [.smoothedSceneDepth]   // less flicker than .sceneDepth
        config.sceneReconstruction = []                  // our point cloud replaces the mesh
        config.environmentTexturing = .none
        config.planeDetection = []
        // Keep the default 1920x1440 @ 30 fps format: same 4:3 aspect as the
        // 256x192 depth map, so image and depth pixels map by a straight scale.
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    func stop() {
        session.pause()
        captureQueue.async { self.token = nil }
    }

    private func emit(_ event: Event) {
        guard let token else { return }
        onEvent?(token, event)
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
