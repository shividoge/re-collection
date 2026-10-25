import Foundation

/// Which capture files upload, in what order, and how each one turns into
/// PUTs to R2 (docs/architecture-v3.md §6.2). Pure Foundation so it's easy
/// to test.
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

    static func contentType(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "json": return "application/json"
        case "jsonl": return "application/x-ndjson"
        case "jpg", "jpeg": return "image/jpeg"
        case "mp4": return "video/mp4"
        case "mov": return "video/quicktime"
        default: return "application/octet-stream"
        }
    }

    /// One PUT: the whole file, or one part of a multipart upload.
    struct Piece: Equatable {
        /// nil for a single PUT of the whole file.
        var partNumber: Int?
        var url: URL
        var headers: [String: String]
        /// Bytes of the file this PUT sends.
        var range: Range<Int64>
    }

    /// The PUTs still needed for a file, from `uploads.start` or
    /// `uploads.resume`. Parts are numbered from 1 and each is `partSize`
    /// bytes except the last. Throws when the answer doesn't fit the file.
    static func pieces(for target: UploadTarget, bytes: Int64) throws -> [Piece] {
        if let single = target.single, target.parts == nil {
            guard let url = URL(string: single.url) else { throw UploadError.unexpected("an upload URL that isn't a URL") }
            return [Piece(partNumber: nil, url: url, headers: single.headers, range: 0..<bytes)]
        }
        guard target.single == nil, let parts = target.parts, let partSize = target.partSize, partSize > 0 else {
            throw UploadError.unexpected("an upload target with neither a single URL nor parts")
        }
        return try parts.map { part in
            guard let url = URL(string: part.url),
                  let range = partRange(partNumber: part.partNumber, partSize: Int64(partSize), bytes: bytes)
            else { throw UploadError.unexpected("part \(part.partNumber) that doesn't fit a \(bytes)-byte file") }
            return Piece(partNumber: part.partNumber, url: url, headers: [:], range: range)
        }
    }

    /// Bytes of part `partNumber` (from 1), or nil if the file has no such part.
    static func partRange(partNumber: Int, partSize: Int64, bytes: Int64) -> Range<Int64>? {
        guard partNumber >= 1, partSize > 0 else { return nil }
        let start = Int64(partNumber - 1) * partSize
        guard start < bytes else { return nil }
        return start..<min(start + partSize, bytes)
    }

    /// Part numbers a multipart upload of `bytes` still lacks.
    static func missingParts(_ finished: [FinishedPart], partSize: Int64, bytes: Int64) -> [Int] {
        guard partSize > 0, bytes > 0 else { return [] }
        let count = Int((bytes + partSize - 1) / partSize)
        let have = Set(finished.map(\.partNumber))
        return (1...count).filter { !have.contains($0) }
    }
}
