import ARKit
import Foundation
import Metal

/// Phases from IOS_CAPTURE_PLAN.md Section 3. `roomSaved` becomes
/// readyToRecord once moment recording exists; later checkpoints add the rest.
enum CapturePhase: Equatable {
    case idle
    case scanningRoom
    case savingRoom
    case roomSaved(RoomExport)
    case failed(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var phase: CapturePhase = .idle
    @Published var trackingMessage: String?
    @Published var previewFPS: Double = 0
    @Published var pointCount = 0
    @Published var roomCaptured = false
    @Published var showsCameraFeed = true

    let isDeviceSupported: Bool
    let engine: CaptureEngine
    private let setupError: String?

    /// Every capture attempt gets a token. Callbacks carrying an older token
    /// are dropped, so a late ARKit callback can't revive a finished capture.
    private var activeToken: UUID?

    init() {
        #if targetEnvironment(simulator)
        isDeviceSupported = false
        #else
        isDeviceSupported = ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth)
        #endif

        var accumulator: PointAccumulator?
        var setupError: String?
        if let device = MTLCreateSystemDefaultDevice() {
            do {
                accumulator = try PointAccumulator(device: device)
            } catch {
                setupError = error.localizedDescription
            }
        } else {
            setupError = "This device has no Metal GPU."
        }
        self.setupError = setupError
        engine = CaptureEngine(accumulator: accumulator)

        engine.onEvent = { [weak self] token, event in
            Task { @MainActor in self?.handle(event, token: token) }
        }
    }

    func startScan() {
        if let setupError {
            phase = .failed(setupError)
            return
        }
        let token = UUID()
        activeToken = token
        trackingMessage = nil
        previewFPS = 0
        pointCount = 0
        roomCaptured = false
        phase = .scanningRoom
        engine.start(token: token)
    }

    /// Stops adding points and writes room.ply and room.bin. The session keeps
    /// running so the moment can later be recorded in the same world frame.
    func finishScan() {
        guard phase == .scanningRoom, let token = activeToken, let accumulator = engine.accumulator else { return }
        phase = .savingRoom
        engine.pauseAccumulation {
            Task.detached(priority: .userInitiated) { [weak self] in
                let result = Result {
                    try accumulator.exportRoom(to: CaptureStore.makeCaptureFolder(id: token))
                }
                await self?.roomSaved(result, token: token)
            }
        }
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

    private func roomSaved(_ result: Result<RoomExport, Error>, token: UUID) {
        guard token == activeToken else { return }
        switch result {
        case .success(let export):
            phase = .roomSaved(export)
        case .failure(let error):
            fail("The room couldn't be saved: \(error.localizedDescription)")
        }
    }

    private func handle(_ event: CaptureEngine.Event, token: UUID) {
        guard token == activeToken else { return }
        switch event {
        case .tracking(let message):
            trackingMessage = message
        case .pointCount(let count):
            pointCount = count
        case .roomCaptured:
            roomCaptured = true
        case .failed(let message):
            fail(message)
        }
    }
}
