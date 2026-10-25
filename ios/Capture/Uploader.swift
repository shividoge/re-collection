import Foundation

/// Uploads a capture through Convex and R2 (docs/architecture-v3.md §6.2):
/// `captures:begin`, then per file `uploads:start` (or `uploads:resume`),
/// PUTs straight to R2 on a background URLSession, `uploads:finish`, and
/// finally `captures:complete`. Every PUT is handed to the system up front,
/// so uploading carries on while the phone is locked or the app suspended.
/// The job is saved after each step, so a relaunch resumes instead of
/// starting over.
struct Uploader {
    struct Progress: Equatable {
        var sentBytes: Int64
        var totalBytes: Int64
        var filesDone: Int
        var fileCount: Int

        var fraction: Double { totalBytes > 0 ? min(1, Double(sentBytes) / Double(totalBytes)) : 0 }
    }

    /// Rounds before giving up on errors that might pass (network, expired URLs).
    static let maxRounds = 3
    /// Convex calls in flight at once.
    static let parallelCalls = 4

    let convex: ConvexClient
    var transfers: BackgroundTransfers = .shared

    /// Uploads, or resumes, the capture in `folder`. `onProgress` runs on the main actor.
    func upload(folder: URL, manifestId: String, onProgress: @escaping @MainActor @Sendable (Progress) -> Void) async throws {
        let store = UploadJobStore(manifestId: manifestId)
        await transfers.finishLeftovers()
        var round = 1
        while true {
            do {
                try await uploadOnce(folder: folder, store: store, onProgress: onProgress)
                store.remove()
                return
            } catch let error as UploadError where !error.isRetryable {
                throw error
            } catch {
                if round == Self.maxRounds || error is CancellationError { throw error }
                try await Task.sleep(nanoseconds: UInt64(round) * 3_000_000_000)
                round += 1
            }
        }
    }

    /// One PUT handed to the background session.
    private struct Queued: Sendable {
        var partNumber: Int?
        var taskId: Int
    }

    /// One file's PUTs and what's needed to finish it.
    private struct FilePlan: Sendable {
        var index: Int
        var name: String
        var bytes: Int64
        var target: UploadTarget
        /// Parts R2 already had before this round.
        var done: [FinishedPart]
        var queued: [Queued] = []
    }

    private func uploadOnce(folder: URL, store: UploadJobStore, onProgress: @escaping @MainActor @Sendable (Progress) -> Void) async throws {
        let names = try CaptureStore.files(in: folder)
        let current = try UploadJobStore.currentFiles(in: folder, names: names)
        let fresh = UploadJob(convexURL: convex.baseURL, manifestId: store.manifestId, folderName: folder.lastPathComponent, captureId: nil, files: [])
        var job = (store.load() ?? fresh).reconciled(with: current, convexURL: convex.baseURL)
        try store.save(job)

        let captureId: String
        if let known = job.captureId {
            captureId = known
        } else {
            let manifest = try String(contentsOf: folder.appendingPathComponent("manifest.json"), encoding: .utf8)
            captureId = try await convex.begin(manifestJson: manifest)
            job.captureId = captureId
            try store.save(job)
        }

        // 1. Where each unfinished file goes, a few Convex calls at a time.
        let files = job.files
        var plans = try await Self.inParallel(files.indices.filter { !files[$0].finished }) { [convex] i -> FilePlan in
            let file = files[i]
            if let uploadId = file.uploadId {
                do {
                    let resumed = try await convex.resumeUpload(uploadId: uploadId)
                    return FilePlan(index: i, name: file.name, bytes: file.bytes, target: resumed.target, done: resumed.done)
                } catch where Self.shouldRestart(afterResumeFailed: error) {
                    // The old upload is gone (aborted, expired or already finished); start this file over.
                }
            }
            let target = try await convex.startUpload(captureId: captureId, name: file.name, bytes: file.bytes)
            return FilePlan(index: i, name: file.name, bytes: file.bytes, target: target, done: [])
        }
        plans.sort { $0.index < $1.index }
        for plan in plans { job.files[plan.index].uploadId = plan.target.uploadId }
        try store.save(job)

        // 2. Hand every PUT to the system now, while the app is in front, in upload order.
        for p in plans.indices {
            let source = folder.appendingPathComponent(plans[p].name)
            for piece in try UploadPlan.pieces(for: plans[p].target, bytes: plans[p].bytes) {
                var body = source
                if let part = piece.partNumber {
                    body = store.partURL(file: plans[p].index, part: part)
                    try store.cut(source, range: piece.range, to: body)
                }
                var request = URLRequest(url: piece.url)
                request.httpMethod = "PUT"
                for (field, value) in piece.headers { request.setValue(value, forHTTPHeaderField: field) }
                let label = plans[p].name + (piece.partNumber.map { " part \($0)" } ?? "")
                plans[p].queued.append(Queued(partNumber: piece.partNumber, taskId: transfers.put(request, fromFile: body, label: label)))
            }
        }

        // Progress: bytes R2 already had, plus what the background session reports.
        let partSize = { (plan: FilePlan) in Int64(plan.target.partSize ?? 0) }
        let alreadySent = job.files.filter(\.finished).reduce(Int64(0)) { $0 + $1.bytes }
            + plans.reduce(Int64(0)) { total, plan in
                total + plan.done.reduce(Int64(0)) { sum, part in
                    sum + Int64(UploadPlan.partRange(partNumber: part.partNumber, partSize: partSize(plan), bytes: plan.bytes)?.count ?? 0)
                }
            }
        let taskIds = plans.flatMap { $0.queued.map(\.taskId) }
        let totalBytes = job.totalBytes
        let fileCount = job.files.count
        let filesDone = Locked(job.files.filter(\.finished).count)
        let transfers = transfers
        let report: @Sendable () async -> Void = {
            await onProgress(Progress(
                sentBytes: alreadySent + transfers.sentBytes(taskIds), totalBytes: totalBytes,
                filesDone: filesDone.value, fileCount: fileCount))
        }
        let ticker = Task {
            while !Task.isCancelled {
                await report()
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        defer { ticker.cancel() }

        // 3. As each file's PUTs land, register it with uploads:finish.
        var firstError: Error?
        let queuedPlans = plans
        _ = try await Self.inParallel(Array(queuedPlans.indices)) { [convex, transfers] p -> (Int, Error?) in
            (queuedPlans[p].index, await Self.finish(queuedPlans[p], convex: convex, transfers: transfers))
        } onEach: { result in
            let (index, error) = result
            if let error {
                firstError = firstError ?? error
            } else {
                job.files[index].finished = true
                try store.save(job)
                store.removeParts(file: index)
                filesDone.value += 1
            }
        }
        await report()
        if let firstError { throw firstError }

        // 4. Every file is in; Convex checks the package against the manifest.
        try await convex.complete(captureId: captureId)
    }

    /// Whether a failed `uploads:resume` means the old upload is gone, so the
    /// file starts over with `uploads:start`. Only the backend can say that, with
    /// a non-retryable function error (`not_found`, "already finished", R2 no
    /// longer knowing the multipart upload). Anything else (network, 5xx, a
    /// storage hiccup marked retryable, cancellation) keeps the upload id and
    /// fails the round, so the parts already in R2 aren't thrown away.
    static func shouldRestart(afterResumeFailed error: Error) -> Bool {
        if case .convex(_, _, _, _, retryable: false) = error as? UploadError { return true }
        return false
    }

    /// Waits for one file's PUTs, then finishes the upload. Returns the first
    /// error instead of throwing, so the other files still finish.
    private static func finish(_ plan: FilePlan, convex: ConvexClient, transfers: BackgroundTransfers) async -> Error? {
        var parts = plan.done
        var failure: Error?
        for queued in plan.queued {
            do {
                let etag = try await transfers.wait(queued.taskId)
                if let number = queued.partNumber {
                    guard let etag, !etag.isEmpty else { throw UploadError.incomplete("\(plan.name) part \(number) came back without an ETag") }
                    parts.append(FinishedPart(partNumber: number, etag: etag))
                }
            } catch {
                failure = failure ?? error
            }
        }
        if let failure { return failure }
        do {
            if plan.target.single != nil {
                try await convex.finishUpload(uploadId: plan.target.uploadId, parts: nil)
            } else {
                parts.sort { $0.partNumber < $1.partNumber }
                let missing = UploadPlan.missingParts(parts, partSize: Int64(plan.target.partSize ?? 0), bytes: plan.bytes)
                guard missing.isEmpty else { throw UploadError.incomplete("\(plan.name) is missing part \(missing[0])") }
                try await convex.finishUpload(uploadId: plan.target.uploadId, parts: parts)
            }
            return nil
        } catch {
            return error
        }
    }

    /// Runs `work` for every item with at most `parallelCalls` at once and
    /// hands each result to `onEach` (on the caller's task) as it arrives.
    private static func inParallel<Item: Sendable, Output: Sendable>(
        _ items: [Item],
        _ work: @escaping @Sendable (Item) async throws -> Output,
        onEach: (Output) async throws -> Void = { _ in }
    ) async throws -> [Output] {
        try await withThrowingTaskGroup(of: Output.self) { group in
            var results: [Output] = []
            var next = 0
            while next < min(parallelCalls, items.count) {
                let item = items[next]
                group.addTask { try await work(item) }
                next += 1
            }
            while let result = try await group.next() {
                results.append(result)
                try await onEach(result)
                if next < items.count {
                    let item = items[next]
                    group.addTask { try await work(item) }
                    next += 1
                }
            }
            return results
        }
    }
}

/// A value shared between an upload and its progress ticker.
private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}

/// The one background URLSession that carries every PUT to R2. The system
/// runs the transfers even while the app is suspended, and wakes the app
/// when they finish (see AppDelegate).
final class BackgroundTransfers: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = BackgroundTransfers()
    static let identifier = "com.shividoge.braindance.capture.uploads"

    private(set) var session: URLSession!

    /// Set by the app delegate when iOS wakes the app for this session's
    /// events; called once they've all been delivered. Main thread only.
    var systemCompletion: (() -> Void)? {
        didSet {
            // The events may already have been delivered before iOS handed over the handler.
            if eventsDelivered, let completion = systemCompletion {
                eventsDelivered = false
                systemCompletion = nil
                completion()
            }
        }
    }
    private var eventsDelivered = false
    /// Called on the main actor after iOS delivered a batch of background events.
    var onEventsDelivered: (@MainActor @Sendable () -> Void)?

    private let lock = NSLock()
    // Guarded by `lock`.
    private var results: [Int: Result<String?, Error>] = [:]
    private var waiters: [Int: CheckedContinuation<Result<String?, Error>, Never>] = [:]
    private var sent: [Int: Int64] = [:]

    override init() {
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.httpMaximumConnectionsPerHost = 4
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    /// Queues a PUT of `file`. Returns the task id to `wait` on.
    func put(_ request: URLRequest, fromFile file: URL, label: String) -> Int {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = label
        // A relaunched session may reuse ids; drop anything an old task left under this one.
        lock.lock()
        results[task.taskIdentifier] = nil
        sent[task.taskIdentifier] = nil
        lock.unlock()
        task.resume()
        return task.taskIdentifier
    }

    /// The ETag R2 answered with (nil if it sent none), or the error.
    func wait(_ taskId: Int) async throws -> String? {
        let result = await withCheckedContinuation { (continuation: CheckedContinuation<Result<String?, Error>, Never>) in
            lock.lock()
            if let result = results.removeValue(forKey: taskId) {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                waiters[taskId] = continuation
                lock.unlock()
            }
        }
        return try result.get()
    }

    func sentBytes(_ taskIds: [Int]) -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return taskIds.reduce(0) { $0 + (sent[$1] ?? 0) }
    }

    /// Waits (at most two minutes) for PUTs an earlier launch queued that are
    /// still running, so resuming doesn't send the same bytes twice.
    func finishLeftovers() async {
        let tasks = await withCheckedContinuation { continuation in
            session.getAllTasks { continuation.resume(returning: $0) }
        }
        let leftovers = tasks.filter { $0.state == .running || $0.state == .suspended }
        // Results of old tasks nobody waits for (they landed while the app wasn't running).
        defer { dropUnclaimedResults() }
        guard !leftovers.isEmpty else { return }
        for task in leftovers {
            if task.state == .suspended { task.resume() }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 120) { task.cancel() }
        }
        for task in leftovers {
            _ = try? await wait(task.taskIdentifier)
        }
    }

    private func dropUnclaimedResults() {
        lock.lock()
        results.removeAll()
        lock.unlock()
    }

    private func resolve(_ taskId: Int, _ result: Result<String?, Error>) {
        lock.lock()
        if let waiter = waiters.removeValue(forKey: taskId) {
            lock.unlock()
            waiter.resume(returning: result)
        } else {
            results[taskId] = result
            lock.unlock()
        }
    }

    // MARK: URLSession delegate (on the session's own queue)

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        lock.lock()
        sent[task.taskIdentifier] = totalBytesSent
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let label = task.taskDescription ?? "a file"
        let result: Result<String?, Error>
        if let error {
            result = .failure(UploadError.network("\(label): \(error.localizedDescription)"))
        } else if let http = task.response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
            result = .success(http.value(forHTTPHeaderField: "ETag"))
        } else {
            result = .failure(UploadError.storage(file: label, status: (task.response as? HTTPURLResponse)?.statusCode ?? 0))
        }
        resolve(task.taskIdentifier, result)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor [self] in
            onEventsDelivered?()
            if let completion = systemCompletion {
                systemCompletion = nil
                completion()
            } else {
                eventsDelivered = true
            }
        }
    }
}
