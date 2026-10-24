import Foundation

/// Capture folders on disk: Documents/captures/capture-<uuid>/. Documents is
/// shared with the Files app (UIFileSharingEnabled), so a capture can always
/// be pulled off the phone by hand even if upload fails.
enum CaptureStore {
    static var capturesDirectory: URL {
        URL.documentsDirectory.appending(path: "captures", directoryHint: .isDirectory)
    }

    static func makeCaptureFolder(id: UUID) throws -> URL {
        let folder = capturesDirectory.appending(path: "capture-\(id.uuidString.lowercased())", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }
}

struct SavedCapture: Equatable {
    let folder: URL
    /// The whole folder zipped, for AirDrop.
    let zipURL: URL
    let durationSec: Double
    let frameCount: Int
    let depthCount: Int
    let warnings: [String]
}

extension CaptureStore {
    static func manifest(
        id: UUID, createdAt: Date, moment: CaptureRecorder.MomentResult, room: RoomExport?
    ) -> CaptureManifest {
        CaptureManifest(
            id: id.uuidString.lowercased(),
            createdAt: ISO8601DateFormatter().string(from: createdAt),
            device: deviceModel(),
            // Named in the review screen (checkpoint 6).
            title: "",
            attendees: [],
            video: .init(
                width: Int(moment.videoSize.width), height: Int(moment.videoSize.height), fps: 30,
                durationSec: (moment.durationSec * 1000).rounded() / 1000, frameCount: moment.frameCount),
            audio: .init(inVideo: true, sampleRate: moment.audioSampleRate, channels: 1),
            depth: .init(width: 256, height: 192, rateHz: 10, count: moment.depthCount),
            room: room.map { .init(points: $0.pointCount, voxelMeters: Double(PointCloudExporter.voxelMeters)) },
            phases: .init(
                scan: moment.scanSpan,
                moment: .init(tStart: 0, tEnd: (moment.durationSec * 1000).rounded() / 1000)),
            warnings: moment.warnings)
    }

    /// Writes manifest.json and zips the folder for sharing.
    static func finalize(folder: URL, manifest: CaptureManifest) throws -> SavedCapture {
        try manifest.encoded().write(to: folder.appending(path: "manifest.json"), options: .atomic)
        return SavedCapture(
            folder: folder,
            zipURL: try zip(folder),
            durationSec: manifest.video.durationSec,
            frameCount: manifest.video.frameCount,
            depthCount: manifest.depth.count,
            warnings: manifest.warnings)
    }

    /// Zips `folder` with the system's built-in archiver (NSFileCoordinator's
    /// `.forUploading`), so a 150 MB capture never sits in memory.
    static func zip(_ folder: URL) throws -> URL {
        let destination = FileManager.default.temporaryDirectory.appending(path: folder.lastPathComponent + ".zip")
        var coordinatorError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: folder, options: .forUploading, error: &coordinatorError) { zipURL in
            do {
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.copyItem(at: zipURL, to: destination)
            } catch {
                copyError = error
            }
        }
        if let error = coordinatorError ?? copyError { throw error }
        return destination
    }

    /// Hardware identifier such as "iPhone17,2" (iPhone 16 Pro Max).
    static func deviceModel() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }
}

struct RoomExport: Equatable {
    let folder: URL
    let plyURL: URL
    let binURL: URL
    let pointCount: Int
}

extension PointAccumulator {
    /// Downsamples the current cloud and writes room.ply and room.bin into
    /// `folder`. Call off the main thread after accumulation has stopped.
    func exportRoom(to folder: URL) throws -> RoomExport {
        waitUntilIdle()
        let count = pointCount
        let raw = pointBuffer.contents().bindMemory(to: CloudPoint.self, capacity: count)
        let points = PointCloudExporter.downsample(UnsafeBufferPointer(start: raw, count: count))
        guard !points.isEmpty else {
            throw ExportError.empty
        }

        let plyURL = folder.appending(path: "room.ply")
        let binURL = folder.appending(path: "room.bin")
        try PointCloudExporter.plyData(points).write(to: plyURL, options: .atomic)
        try PointCloudExporter.roomBinData(points).write(to: binURL, options: .atomic)
        return RoomExport(folder: folder, plyURL: plyURL, binURL: binURL, pointCount: points.count)
    }
}

enum ExportError: LocalizedError {
    case empty

    var errorDescription: String? {
        switch self {
        case .empty: return "No points were captured, so there's no room to save. Scan again and move the phone slowly around the room."
        }
    }
}
