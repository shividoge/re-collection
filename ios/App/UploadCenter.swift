import Foundation
import UIKit

/// The app's one upload at a time, shown on Home and Review. Lives outside
/// AppModel so the app delegate can resume uploads when iOS relaunches the
/// app in the background for upload events, before any screen exists.
@MainActor
final class UploadCenter: ObservableObject {
    static let shared = UploadCenter()

    enum State: Equatable {
        case idle
        case uploading(Uploader.Progress)
        case done
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    /// The manifest id and title of the capture `state` is about.
    @Published private(set) var captureId: String?
    @Published private(set) var title = ""

    /// The Convex deployment, editable in Settings.
    @Published var convexURL: String = UserDefaults.standard.string(forKey: "convexURL") ?? ConvexClient.defaultURL {
        didSet { UserDefaults.standard.set(convexURL, forKey: "convexURL") }
    }

    /// Manifest ids of captures that finished uploading, so their review
    /// screen says "Sent" even after another upload started.
    @Published private(set) var sent: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "sentCaptures") ?? [])

    private var running: Task<Void, Never>?
    /// The folder of the capture `state` is about.
    private var folder: URL?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    var isUploading: Bool {
        if case .uploading = state { return true }
        return false
    }

    /// Uploads (or resumes) a capture. Ignored while another upload runs.
    func upload(folder: URL, manifestId: String, title: String) {
        guard running == nil else { return }
        captureId = manifestId
        self.title = title
        self.folder = folder
        state = .uploading(.init(sentBytes: 0, totalBytes: 0, filesDone: 0, fileCount: 0))
        holdBackgroundTime()
        let uploader = Uploader(convex: ConvexClient(baseURL: convexURL))
        running = Task {
            do {
                try await uploader.upload(folder: folder, manifestId: manifestId) { [weak self] progress in
                    guard let self, case .uploading = self.state, self.captureId == manifestId else { return }
                    self.state = .uploading(progress)
                }
                state = .done
                sent.insert(manifestId)
                UserDefaults.standard.set(Array(sent), forKey: "sentCaptures")
                running = nil
                resumePending()   // the next one waiting, if any
            } catch {
                state = .failed(error.localizedDescription)
                running = nil
            }
            if running == nil { releaseBackgroundTime() }
        }
    }

    /// Picks up the oldest upload an earlier launch didn't finish (at app
    /// start, or when iOS wakes the app for upload events).
    func resumePending() {
        guard running == nil else { return }
        for job in UploadJobStore.pendingJobs() {
            let folder = CaptureStore.capturesDirectory.appending(path: job.folderName, directoryHint: .isDirectory)
            guard FileManager.default.fileExists(atPath: folder.appending(path: "manifest.json").path) else {
                UploadJobStore(manifestId: job.manifestId).remove()   // the capture was deleted in Files
                continue
            }
            upload(folder: folder, manifestId: job.manifestId, title: CaptureStore.readManifest(in: folder)?.title ?? "")
            return
        }
    }

    /// Tries the failed upload again; it resumes where it stopped.
    func retryFailed() {
        guard running == nil, case .failed = state, let captureId, let folder else { return }
        upload(folder: folder, manifestId: captureId, title: title)
    }

    /// Stops trying to upload the capture `state` is about. It stays on the phone.
    func discardFailed() {
        guard running == nil, case .failed = state, let captureId else { return }
        UploadJobStore(manifestId: captureId).remove()
        state = .idle
        self.captureId = nil
    }

    /// Clears a finished upload's message.
    func dismissDone() {
        guard state == .done else { return }
        state = .idle
        captureId = nil
    }

    /// iOS delivered upload events while the app was in the background. The
    /// upload's own code runs on from there (registering the files that
    /// landed); this keeps the app awake long enough for it.
    func backgroundEventsDelivered() {
        if running != nil { holdBackgroundTime() } else { resumePending() }
    }

    /// About 30 s more after the phone locks or the app leaves the screen.
    /// The PUTs themselves don't need it: the system runs them regardless.
    private func holdBackgroundTime() {
        releaseBackgroundTime()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Braindance upload") { [weak self] in
            MainActor.assumeIsolated { self?.releaseBackgroundTime() }
        }
    }

    private func releaseBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
