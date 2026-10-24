import ARKit
import Foundation

/// Phases from IOS_CAPTURE_PLAN.md Section 3. Only the ones checkpoint 1 needs
/// exist so far; later checkpoints add readyToRecord, recordingMoment, etc.
enum CapturePhase: Equatable {
    case idle
    case scanningRoom
    case failed(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var phase: CapturePhase = .idle
    @Published var trackingMessage: String?
    @Published var previewFPS: Double = 0

    let isDeviceSupported: Bool
    let engine = CaptureEngine()

    /// Every capture attempt gets a token. Callbacks carrying an older token
    /// are dropped, so a late ARKit callback can't revive a finished capture.
    private var activeToken: UUID?

    init() {
        #if targetEnvironment(simulator)
        isDeviceSupported = false
        #else
        isDeviceSupported = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
        #endif

        engine.onEvent = { [weak self] token, event in
            Task { @MainActor in self?.handle(event, token: token) }
        }
    }

    func startScan() {
        let token = UUID()
        activeToken = token
        trackingMessage = nil
        previewFPS = 0
        phase = .scanningRoom
        engine.start(token: token)
    }

    func stopScan() {
        endCapture()
        phase = .idle
    }

    func fail(_ message: String) {
        guard activeToken != nil else { return }
        endCapture()
        phase = .failed(message)
    }

    func dismissFailure() {
        if case .failed = phase { phase = .idle }
    }

    func appLeftForeground() {
        fail("The app left the foreground, so the capture stopped. Start again when you're ready.")
    }

    private func endCapture() {
        activeToken = nil
        engine.stop()
    }

    private func handle(_ event: CaptureEngine.Event, token: UUID) {
        guard token == activeToken else { return }
        switch event {
        case .tracking(let message):
            trackingMessage = message
        case .failed(let message):
            fail(message)
        }
    }
}
