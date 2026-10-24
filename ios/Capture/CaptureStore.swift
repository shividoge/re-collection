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
