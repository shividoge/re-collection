import CoreTransferable
import Foundation
import UniformTypeIdentifiers

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

/// A finished capture on disk, shown on the review screen.
struct SavedCapture: Equatable {
    let id: String
    let folder: URL
    var manifest: CaptureManifest
    /// What on-device recognition heard, for the review screen. Nil when there's no transcript.
    let transcript: TranscriptFile?

    var videoURL: URL { folder.appending(path: manifest.video.file) }
}

extension CaptureStore {
    static func manifest(
        id: UUID, createdAt: Date, moment: CaptureRecorder.MomentResult, room: RoomExport?,
        keyframeCount: Int, transcript: TranscriptFile?, extraWarnings: [String]
    ) -> CaptureManifest {
        let duration = (moment.durationSec * 1000).rounded() / 1000
        return CaptureManifest(
            id: id.uuidString.lowercased(),
            createdAt: ISO8601DateFormatter().string(from: createdAt),
            device: deviceModel(),
            // Filled in on the review screen.
            title: "",
            attendees: [],
            video: .init(
                file: moment.videoFile,
                width: Int(moment.videoSize.width), height: Int(moment.videoSize.height), fps: moment.fps,
                durationSec: duration, frameCount: moment.frameCount),
            audio: .init(inVideo: true, sampleRate: moment.audioSampleRate, channels: 1),
            depth: .init(width: RecordingFormat.depthWidth, height: RecordingFormat.depthHeight, rateHz: 10, count: moment.depthCount),
            room: room.map { .init(points: $0.pointCount, voxelMeters: Double(PointCloudExporter.voxelMeters)) },
            transcript: transcript.map { .init(locale: $0.locale) },
            keyframes: keyframeCount > 0 ? .init(count: keyframeCount) : nil,
            phases: .init(scan: moment.scanSpan, moment: .init(tStart: 0, tEnd: duration)),
            warnings: moment.warnings + extraWarnings)
    }

    static func readManifest(in folder: URL) -> CaptureManifest? {
        guard let data = try? Data(contentsOf: folder.appending(path: "manifest.json")) else { return nil }
        return try? JSONDecoder().decode(CaptureManifest.self, from: data)
    }

    static func writeManifest(_ manifest: CaptureManifest, in folder: URL) throws {
        try manifest.encoded().write(to: folder.appending(path: "manifest.json"), options: .atomic)
    }

    /// Every file in the capture folder, as names relative to it ("keyframes/k0001.jpg").
    static func files(in folder: URL) throws -> [String] {
        let base = folder.standardizedFileURL.path + "/"
        guard let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        var names: [String] = []
        for case let url as URL in walker where (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            names.append(String(url.standardizedFileURL.path.dropFirst(base.count)))
        }
        return names
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

/// Shares a capture folder as a zip. The zip is made only when the person
/// actually shares, so it always includes the latest manifest.
struct CaptureArchive: Transferable {
    let folder: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .zip) { archive in
            SentTransferredFile(try CaptureStore.zip(archive.folder))
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
