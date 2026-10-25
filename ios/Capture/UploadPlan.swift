import Foundation

/// Which capture files upload, in what order, and how a file splits into
/// multipart parts. Pure Foundation so it's easy to test.
enum UploadPlan {
    /// Kept on the phone but never uploaded: room.ply duplicates room.bin.
    static let phoneOnly: Set<String> = ["room.ply"]

    /// Claude's inputs (manifest, thumb, transcript, keyframes) go first so
    /// fact extraction can start early; the big files go last.
    static func order(_ files: [String]) -> [String] {
        func rank(_ name: String) -> Int {
            switch name {
            case "manifest.json": return 0
            case "thumb.jpg": return 1
            case "transcript.json": return 2
            case _ where name.hasPrefix("keyframes/"): return 3
            case "room.bin": return 4
            case "frames.jsonl": return 5
            case _ where name.hasPrefix("video."): return 6
            case "depth.index.json": return 7
            case "depth.bin": return 8
            default: return 9
            }
        }
        return files
            .filter { !$0.hasPrefix(".") && !$0.hasSuffix(".zip") && !$0.contains("/.") && !phoneOnly.contains($0) }
            .sorted { (rank($0), $0) < (rank($1), $1) }
    }

    /// Joins a base URL (as typed in Settings) with an API path.
    /// Adds https:// when no scheme was typed and drops trailing slashes.
    static func url(base: String, path: String) -> URL? {
        var trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        let encodedPath = path
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
        return URL(string: trimmed + encodedPath)
    }
}
