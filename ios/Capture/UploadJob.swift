import Foundation

/// How far one capture's upload got, saved after every step so a relaunch
/// (even after a force-quit) carries on instead of starting over. R2 itself
/// remembers which parts arrived; `uploads:resume` reports them.
struct UploadJob: Codable, Equatable {
    struct File: Codable, Equatable {
        var name: String
        var bytes: Int64
        /// Modification time when the upload started; a change means start that file over.
        var modified: Double
        var uploadId: String?
        var finished = false
    }

    var convexURL: String
    /// The manifest's id; also the name of the job's folder.
    var manifestId: String
    /// "capture-<id>" inside CaptureStore.capturesDirectory. Stored as a name
    /// because the app's container path changes between installs.
    var folderName: String
    var captureId: String?
    var files: [File]

    /// The job brought in line with the files on disk now. A file whose size
    /// or modification time changed (the title edited after a failed upload,
    /// say) starts over; files no longer there are dropped. A different
    /// Convex deployment means a fresh job.
    func reconciled(with current: [File], convexURL: String) -> UploadJob {
        guard convexURL == self.convexURL else {
            return UploadJob(convexURL: convexURL, manifestId: manifestId, folderName: folderName, captureId: nil, files: current)
        }
        var job = self
        job.files = current.map { file in
            if let known = files.first(where: { $0.name == file.name }), known.bytes == file.bytes, known.modified == file.modified {
                return known
            }
            return file
        }
        return job
    }

    var totalBytes: Int64 { files.reduce(0) { $0 + $1.bytes } }
}

/// Upload jobs on disk: Application Support/uploads/<manifestId>/job.json,
/// plus the part files cut from big files (background uploads have to send
/// whole files, so each multipart part is its own file until it lands).
struct UploadJobStore {
    let manifestId: String

    static var root: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("uploads", isDirectory: true)
    }

    var directory: URL { Self.root.appendingPathComponent(manifestId, isDirectory: true) }
    private var jobURL: URL { directory.appendingPathComponent("job.json") }
    private var partsDirectory: URL { directory.appendingPathComponent("parts", isDirectory: true) }

    func load() -> UploadJob? {
        guard let data = try? Data(contentsOf: jobURL) else { return nil }
        return try? JSONDecoder().decode(UploadJob.self, from: data)
    }

    func save(_ job: UploadJob) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(job).write(to: jobURL, options: .atomic)
    }

    /// Forgets the job and its part files.
    func remove() {
        try? FileManager.default.removeItem(at: directory)
    }

    func partURL(file index: Int, part: Int) -> URL {
        partsDirectory.appendingPathComponent("\(index)-\(part)")
    }

    func removeParts(file index: Int) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: partsDirectory.path) else { return }
        for name in names where name.hasPrefix("\(index)-") {
            try? FileManager.default.removeItem(at: partsDirectory.appendingPathComponent(name))
        }
    }

    /// Copies `range` of `source` into its own file, 1 MB at a time.
    func cut(_ source: URL, range: Range<Int64>, to destination: URL) throws {
        try FileManager.default.createDirectory(at: partsDirectory, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: destination)
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: destination.path])
        }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        try input.seek(toOffset: UInt64(range.lowerBound))
        var left = range.upperBound - range.lowerBound
        while left > 0 {
            let chunk = try input.read(upToCount: Int(min(Int64(1 << 20), left))) ?? Data()
            guard !chunk.isEmpty else { throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: source.path]) }
            try output.write(contentsOf: chunk)
            left -= Int64(chunk.count)
        }
    }

    /// Jobs an earlier launch didn't finish, oldest first.
    static func pendingJobs() -> [UploadJob] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return [] }
        return names
            .compactMap { name -> (UploadJob, Date)? in
                let store = UploadJobStore(manifestId: name)
                guard let job = store.load() else { return nil }
                let created = (try? FileManager.default.attributesOfItem(atPath: store.directory.path)[.creationDate] as? Date) ?? .distantPast
                return (job, created)
            }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
    }

    /// The files of `folder` that upload, in upload order, as they are on disk now.
    static func currentFiles(in folder: URL, names: [String]) throws -> [UploadJob.File] {
        try UploadPlan.order(names).map { name in
            let values = try folder.appendingPathComponent(name).resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            return UploadJob.File(
                name: name,
                bytes: Int64(values.fileSize ?? 0),
                modified: values.contentModificationDate?.timeIntervalSince1970 ?? 0)
        }
    }
}
