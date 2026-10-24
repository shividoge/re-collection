import Foundation

/// Uploads a capture folder to the guide server (docs/guide-api.md): each file
/// with PUT, up to three tries per file, then POST complete. Files stream from
/// disk, so a 200 MB capture never sits in memory.
struct Uploader {
    struct Progress: Equatable {
        var sentBytes: Int64
        var totalBytes: Int64
        var currentFile: String

        var fraction: Double { totalBytes > 0 ? Double(sentBytes) / Double(totalBytes) : 0 }
    }

    static let maxAttempts = 3

    let baseURL: String
    let key: String

    /// Uploads everything and validates on the server. `onProgress` runs on the main actor.
    func upload(_ capture: SavedCapture, onProgress: @escaping @MainActor (Progress) -> Void) async throws {
        let names = UploadPlan.order(try CaptureStore.files(in: capture.folder))
        let sizes = names.map { Int64((try? capture.folder.appending(path: $0).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        let total = sizes.reduce(0, +)
        var done: Int64 = 0

        for (name, size) in zip(names, sizes) {
            let fileURL = capture.folder.appending(path: name)
            guard let url = UploadPlan.url(base: baseURL, path: "/api/captures/\(capture.id)/files/\(name)") else {
                throw UploadError.badURL(baseURL)
            }
            let sentBefore = done
            try await withRetries(name) {
                let tracker = ProgressTracker { sent in
                    Task { @MainActor in onProgress(Progress(sentBytes: sentBefore + sent, totalBytes: total, currentFile: name)) }
                }
                var put = request(url, method: "PUT")
                put.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                let (data, response) = try await URLSession.shared.upload(for: put, fromFile: fileURL, delegate: tracker)
                try check(response, data, file: name)
            }
            done += size
            await onProgress(Progress(sentBytes: done, totalBytes: total, currentFile: name))
        }

        guard let completeURL = UploadPlan.url(base: baseURL, path: "/api/captures/\(capture.id)/complete") else {
            throw UploadError.badURL(baseURL)
        }
        let (data, response) = try await URLSession.shared.data(for: request(completeURL, method: "POST"))
        try check(response, data, file: nil)
    }

    private func request(_ url: URL, method: String) -> URLRequest {
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.httpMethod = method
        if !key.isEmpty { request.setValue(key, forHTTPHeaderField: "X-Braindance-Key") }
        return request
    }

    private func withRetries(_ name: String, _ attempt: () async throws -> Void) async throws {
        var lastError: Error?
        for tryNumber in 1...Self.maxAttempts {
            do {
                try await attempt()
                return
            } catch let error as UploadError where !error.isRetryable {
                throw error
            } catch {
                lastError = error
                if tryNumber < Self.maxAttempts { try await Task.sleep(for: .seconds(Double(tryNumber))) }
            }
        }
        throw UploadError.gaveUp(file: name, underlying: lastError?.localizedDescription ?? "unknown error")
    }

    /// Turns the guide's `{ "error": "..." }` responses into readable errors.
    private func check(_ response: URLResponse, _ data: Data, file: String?) throws {
        guard let http = response as? HTTPURLResponse else { throw UploadError.server(status: 0, message: "No HTTP response.", file: file) }
        guard !(200..<300).contains(http.statusCode) else { return }
        let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            ?? (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
        throw UploadError.server(status: http.statusCode, message: message, file: file)
    }
}

/// Reports bytes sent for one upload task.
private final class ProgressTracker: NSObject, URLSessionTaskDelegate {
    let onSent: (Int64) -> Void

    init(onSent: @escaping (Int64) -> Void) {
        self.onSent = onSent
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        onSent(totalBytesSent)
    }
}

enum UploadError: LocalizedError {
    case badURL(String)
    case server(status: Int, message: String, file: String?)
    case gaveUp(file: String, underlying: String)

    /// 4xx answers (bad key, invalid package) won't change on a retry; 5xx and network errors might.
    var isRetryable: Bool {
        if case .server(let status, _, _) = self { return status >= 500 }
        return false
    }

    var errorDescription: String? {
        switch self {
        case .badURL(let base):
            return "\"\(base)\" isn't a usable guide URL. Check it in Settings."
        case .server(401, _, _):
            return "The guide rejected the key. Check the key in Settings."
        case .server(let status, let message, let file):
            return file.map { "\($0): \(message) (HTTP \(status))" } ?? "\(message) (HTTP \(status))"
        case .gaveUp(let file, let underlying):
            return "\(file) failed to upload after \(Uploader.maxAttempts) tries: \(underlying)"
        }
    }
}
