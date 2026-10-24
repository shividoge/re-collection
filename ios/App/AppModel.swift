import ARKit
import Foundation
import Metal

/// Phases from IOS_CAPTURE_PLAN.md Section 3. `roomSaved` is the plan's
/// readyToRecord; review and upload come in later checkpoints.
enum CapturePhase: Equatable {
    case idle
    case scanningRoom
    case savingRoom
    case roomSaved(RoomExport)
    case recordingMoment(startedAt: Date)
    case savingMoment
    case momentSaved(SavedCapture)
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
    /// The token is also the capture's id and folder name.
    private var activeToken: UUID?
    private var captureFolder: URL?
    private var captureStartedAt = Date()
    private var room: RoomExport?

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

    var isRecordingMoment: Bool {
        if case .recordingMoment = phase { return true }
        return false
    }

    func startScan() {
        if let setupError {
            phase = .failed(setupError)
            return
        }
        let token = UUID()
        let folder: URL
        do {
            folder = try CaptureStore.makeCaptureFolder(id: token)
        } catch {
            phase = .failed("The capture folder couldn't be created: \(error.localizedDescription)")
            return
        }
        activeToken = token
        captureFolder = folder
        captureStartedAt = Date()
        room = nil
        trackingMessage = nil
        previewFPS = 0
        pointCount = 0
        roomCaptured = false
        phase = .scanningRoom
        engine.start(token: token, folder: folder)
    }

    /// Stops adding points and writes room.ply and room.bin. The session keeps
    /// running so the moment is recorded in the same world frame.
    func finishScan() {
        guard phase == .scanningRoom, let token = activeToken, let folder = captureFolder,
              let accumulator = engine.accumulator
        else { return }
        phase = .savingRoom
        engine.pauseAccumulation {
            Task.detached(priority: .userInitiated) { [weak self] in
                let result = Result { try accumulator.exportRoom(to: folder) }
                await self?.roomSaved(result, token: token)
            }
        }
    }

    func recordMoment() {
        guard case .roomSaved = phase else { return }
        phase = .recordingMoment(startedAt: Date())
        engine.beginMoment()
    }

    func stopMoment() {
        guard isRecordingMoment, let token = activeToken else { return }
        phase = .savingMoment
        engine.finishMoment { result in
            Task { @MainActor [weak self] in await self?.momentFinished(result, token: token) }
        }
    }

    /// Ends the capture and returns home. Files already written stay on disk.
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
            room = export
            phase = .roomSaved(export)
        case .failure(let error):
            fail("The room couldn't be saved: \(error.localizedDescription)")
        }
    }

    private func momentFinished(_ result: Result<CaptureRecorder.MomentResult, Error>, token: UUID) async {
        guard token == activeToken, let folder = captureFolder else { return }
        let moment: CaptureRecorder.MomentResult
        switch result {
        case .success(let value):
            moment = value
        case .failure(let error):
            fail("The visit couldn't be saved: \(error.localizedDescription)")
            return
        }

        let manifest = CaptureStore.manifest(
            id: token, createdAt: captureStartedAt, moment: moment, room: room)
        let saved = await Task.detached(priority: .userInitiated) {
            Result { try CaptureStore.finalize(folder: folder, manifest: manifest) }
        }.value

        guard token == activeToken else { return }
        switch saved {
        case .success(let capture):
            phase = .momentSaved(capture)
        case .failure(let error):
            fail("The visit couldn't be saved: \(error.localizedDescription)")
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
        case .momentTimeLimitReached:
            stopMoment()
        case .failed(let message):
            fail(message)
        }
    }
}
