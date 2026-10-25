import ARKit
import Foundation
import Metal

/// Phases from IOS_CAPTURE_PLAN.md Section 3. `roomSaved` is the plan's
/// readyToRecord; `savingMoment` covers finishing the files and the transcript.
enum CapturePhase: Equatable {
    case idle
    case scanningRoom
    case savingRoom
    case roomSaved(RoomExport)
    case recordingMoment(startedAt: Date)
    case savingMoment(step: String)
    case review(SavedCapture)
    case failed(String)

    /// Phases with the camera running, where leaving the app breaks the capture.
    var isLive: Bool {
        switch self {
        case .scanningRoom, .savingRoom, .roomSaved, .recordingMoment: return true
        default: return false
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var phase: CapturePhase = .idle
    @Published var trackingMessage: String?
    @Published var previewFPS: Double = 0
    @Published var pointCount = 0
    @Published var roomCaptured = false
    @Published var showsCameraFeed = true
    /// Set when the review screen's title or names couldn't be saved.
    @Published private(set) var saveError: String?

    /// Also keep medium-confidence depth within 3 m in the room scan (Settings).
    @Published var keepMediumConfidence: Bool = UserDefaults.standard.bool(forKey: "keepMediumConfidence") {
        didSet {
            UserDefaults.standard.set(keepMediumConfidence, forKey: "keepMediumConfidence")
            engine.accumulator?.keepsMediumConfidence = keepMediumConfidence
        }
    }

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
        accumulator?.keepsMediumConfidence = keepMediumConfidence

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
        PostProcessor.requestSpeechPermission()
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
        engine.pauseAccumulation { [weak self] in
            Task.detached(priority: .userInitiated) {
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
        phase = .savingMoment(step: "Saving the video…")
        engine.finishMoment { [weak self] result in
            Task { @MainActor in await self?.momentFinished(result, token: token) }
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

    /// Only a live capture breaks when the app leaves the foreground. Saving
    /// and review carry on; the files are already on disk.
    func appLeftForeground() {
        guard phase.isLive else { return }
        fail("The app left the foreground, so the capture stopped. Start again when you're ready.")
    }

    /// Saves the title and attendees from the review screen into manifest.json.
    func saveDetails(title: String, attendees: [String]) {
        guard case .review(var capture) = phase else { return }
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        // Rewriting an unchanged manifest would make an upload send it again;
        // and once uploading, manifest.json is one of the files going up.
        guard title != capture.manifest.title || attendees != capture.manifest.attendees,
              !UploadCenter.shared.isUploading
        else { return }
        capture.manifest.title = title
        capture.manifest.attendees = attendees
        do {
            try CaptureStore.writeManifest(capture.manifest, in: capture.folder)
            saveError = nil
            phase = .review(capture)
        } catch {
            saveError = "The details couldn't be saved: \(error.localizedDescription)"
        }
    }

    /// Sends the capture on the review screen through Convex and R2. It
    /// carries on in the background, and after a relaunch.
    func uploadCapture() {
        guard case .review(let capture) = phase else { return }
        UploadCenter.shared.upload(folder: capture.folder, manifestId: capture.id, title: capture.manifest.title)
    }

    /// Leaves the review screen. The capture stays on the phone (Files app),
    /// and an upload in progress keeps going.
    func finishReview() {
        saveError = nil
        phase = .idle
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
        // The camera isn't needed any more; stopping it saves battery and heat.
        engine.stop()

        let videoURL = folder.appending(path: moment.videoFile)
        var warnings: [String] = []

        phase = .savingMoment(step: "Finishing the transcript…")
        let (transcript, transcriptWarning) = await PostProcessor.transcript(live: moment.transcriber, video: videoURL, folder: folder)
        if let transcriptWarning { warnings.append(transcriptWarning) }

        guard token == activeToken else { return }
        let manifest = CaptureStore.manifest(
            id: token, createdAt: captureStartedAt, moment: moment, room: room,
            keyframeCount: moment.keyframeCount, transcript: transcript, extraWarnings: warnings)
        do {
            try CaptureStore.writeManifest(manifest, in: folder)
        } catch {
            fail("The visit couldn't be saved: \(error.localizedDescription)")
            return
        }
        activeToken = nil
        saveError = nil
        phase = .review(SavedCapture(id: manifest.id, folder: folder, manifest: manifest, transcript: transcript))
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
