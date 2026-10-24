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
        case momentTimeLimitReached
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
    private var recorder: CaptureRecorder?

    init(accumulator: PointAccumulator?) {
        self.accumulator = accumulator
        super.init()
        session.delegate = self
        session.delegateQueue = captureQueue
    }

    /// Starts a fresh capture whose files go in `folder`.
    func start(token: UUID, folder: URL) {
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
        // Set from the start: changing the configuration later could shift
        // the world frame, and the scan and the moment must share one.
        config.providesAudioData = true
        // 1920x1440 @ 30 fps: same 4:3 aspect as the 256x192 depth map, so
        // image and depth pixels map by a straight scale. The iPhone 16 Pro Max
        // defaults to 60 fps, which doubles the data for no gain here.
        if let format = ARWorldTrackingConfiguration.supportedVideoFormats.first(where: {
            $0.imageResolution == CGSize(width: 1920, height: 1440) && $0.framesPerSecond == 30
        }) {
            config.videoFormat = format
        }
        let fps = config.videoFormat.framesPerSecond
        captureQueue.async {
            do {
                self.recorder = try CaptureRecorder(folder: folder, fps: fps)
            } catch {
                self.emit(.failed("The capture files couldn't be created: \(error.localizedDescription)"))
            }
        }
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    /// Stops adding points but keeps the session (and its world frame)
    /// running. `then` runs on the capture queue once no new pass can start.
    func pauseAccumulation(then: @escaping () -> Void) {
        captureQueue.async {
            self.isAccumulating = false
            self.recorder?.pauseScan()
            then()
        }
    }

    /// Starts recording the moment on the next frame, in the same session.
    func beginMoment() {
        captureQueue.async { self.recorder?.beginMoment() }
    }

    /// Finishes the moment's files. `completion` runs on an arbitrary queue.
    func finishMoment(completion: @escaping (Result<CaptureRecorder.MomentResult, Error>) -> Void) {
        captureQueue.async {
            guard let recorder = self.recorder else {
                completion(.failure(RecorderError.noFrames))
                return
            }
            recorder.finishMoment(completion: completion)
        }
    }

    func stop() {
        session.pause()
        captureQueue.async {
            self.token = nil
            self.isAccumulating = false
            self.recorder?.cancel()
            self.recorder = nil
        }
    }

    private func emit(_ event: Event) {
        guard let token else { return }
        onEvent?(token, event)
    }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard token != nil else { return }
        if let recorder {
            switch recorder.handle(frame) {
            case .ok: break
            case .reachedTimeLimit: emit(.momentTimeLimitReached)
            case .failed(let message): emit(.failed(message))
            }
        }
        accumulate(frame)
    }

    func session(_ session: ARSession, didOutputAudioSampleBuffer audioSampleBuffer: CMSampleBuffer) {
        guard token != nil else { return }
        recorder?.handleAudio(audioSampleBuffer)
    }

    private func accumulate(_ frame: ARFrame) {
        guard isAccumulating, let accumulator else { return }

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
        } else if let arError = error as? ARError, arError.code == .microphoneUnauthorized {
            message = "Braindance needs microphone access to record the visit. Turn it on in Settings > Braindance, then try again."
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
