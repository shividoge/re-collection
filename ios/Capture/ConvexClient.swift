import Foundation

/// Calls Convex functions over its HTTP API (https://docs.convex.dev/http-api):
/// `POST <deployment>/api/mutation` (or `/api/action`, `/api/query`) with
/// `{ "path": "captures:begin", "args": {...}, "format": "json" }`. The answer
/// is `{ "status": "success", "value": ... }` or `{ "status": "error",
/// "errorMessage": ..., "errorData": ... }`.
struct ConvexClient {
    enum Kind: String {
        case query, mutation, action
    }

    static let defaultURL = "https://adamant-schnauzer-171.convex.cloud"

    let baseURL: String
    var session: URLSession = .shared

    func call<Args: Encodable, Value: Decodable>(_ kind: Kind, _ path: String, _ args: Args) async throws -> Value {
        guard let url = UploadPlan.url(base: baseURL, path: "/api/\(kind.rawValue)") else { throw UploadError.badURL(baseURL) }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Call(path: path, args: args))
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw UploadError.network(error.localizedDescription)
        }
        return try Self.parse(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0, path: path)
    }

    /// Turns Convex's answer into the function's value or a readable error.
    static func parse<Value: Decodable>(_ data: Data, status: Int, path: String) throws -> Value {
        if let envelope = try? JSONDecoder().decode(Envelope<Value>.self, from: data) {
            if envelope.status == "success", let value = envelope.value { return value }
            if envelope.status == "error" {
                throw UploadError.convex(
                    function: path,
                    message: envelope.errorMessage ?? "unknown error",
                    code: envelope.errorData?.code,
                    details: envelope.errorData?.errors ?? [])
            }
        }
        if !(200..<300).contains(status) {
            // Errors outside a function (bad request, deployment down) are `{ "code", "message" }`.
            let message = (try? JSONDecoder().decode(PlainError.self, from: data))?.message
            throw UploadError.http(status: status, function: path, message: message)
        }
        throw UploadError.unexpected("an answer from \(path) the app can't read")
    }

    private struct Call<Args: Encodable>: Encodable {
        let path: String
        let args: Args
        let format = "json"
    }

    private struct Envelope<Value: Decodable>: Decodable {
        var status: String
        var value: Value?
        var errorMessage: String?
        var errorData: ErrorData?
    }

    /// `ConvexError({ code, errors })` data. Anything else is ignored.
    private struct ErrorData: Decodable {
        var code: String?
        var errors: [String]?

        private enum Keys: String, CodingKey { case code, errors }

        init(from decoder: Decoder) throws {
            let container = try? decoder.container(keyedBy: Keys.self)
            code = (try? container?.decodeIfPresent(String.self, forKey: .code)) ?? nil
            errors = (try? container?.decodeIfPresent([String].self, forKey: .errors)) ?? nil
        }
    }

    private struct PlainError: Decodable {
        var message: String?
    }
}

// MARK: The functions the phone calls (backend/convex/captures.ts, uploads.ts)

struct UploadTarget: Codable, Equatable {
    struct Part: Codable, Equatable {
        var partNumber: Int
        var url: String
    }

    struct Single: Codable, Equatable {
        var url: String
        var headers: [String: String]
    }

    var uploadId: String
    var key: String
    var partSize: Int?
    var parts: [Part]?
    var single: Single?
}

struct FinishedPart: Codable, Equatable {
    var partNumber: Int
    var etag: String
}

enum ConvexAPI {
    struct NoArgs: Encodable {}

    struct Begin: Encodable { var manifestJson: String }
    struct BeginResult: Decodable { var captureId: String }

    struct Start: Encodable {
        var captureId: String
        var name: String
        var bytes: Int64
        var contentType: String
    }

    struct Resume: Encodable { var uploadId: String }
    struct ResumeResult: Decodable {
        var target: UploadTarget
        var done: [FinishedPart]
    }

    struct Finish: Encodable {
        var uploadId: String
        /// Omitted for a single PUT.
        var parts: [FinishedPart]?
    }

    struct FinishResult: Decodable { var ok: Bool }

    struct Complete: Encodable { var captureId: String }
    struct OK: Decodable { var ok: Bool }
}

extension ConvexClient {
    func begin(manifestJson: String) async throws -> String {
        let result: ConvexAPI.BeginResult = try await call(.mutation, "captures:begin", ConvexAPI.Begin(manifestJson: manifestJson))
        return result.captureId
    }

    func startUpload(captureId: String, name: String, bytes: Int64) async throws -> UploadTarget {
        try await call(.action, "uploads:start", ConvexAPI.Start(
            captureId: captureId, name: name, bytes: bytes, contentType: UploadPlan.contentType(for: name)))
    }

    func resumeUpload(uploadId: String) async throws -> ConvexAPI.ResumeResult {
        try await call(.action, "uploads:resume", ConvexAPI.Resume(uploadId: uploadId))
    }

    func finishUpload(uploadId: String, parts: [FinishedPart]?) async throws {
        let _: ConvexAPI.FinishResult = try await call(.action, "uploads:finish", ConvexAPI.Finish(uploadId: uploadId, parts: parts))
    }

    func complete(captureId: String) async throws {
        let _: ConvexAPI.OK = try await call(.mutation, "captures:complete", ConvexAPI.Complete(captureId: captureId))
    }

    /// `system:health`, for "Test connection" in Settings.
    func health() async throws {
        let _: ConvexAPI.OK = try await call(.query, "system:health", ConvexAPI.NoArgs())
    }
}

enum UploadError: LocalizedError, Equatable {
    case badURL(String)
    case network(String)
    case http(status: Int, function: String, message: String?)
    case convex(function: String, message: String, code: String?, details: [String])
    /// R2 refused a PUT (an expired URL answers 403).
    case storage(file: String, status: Int)
    /// Some part didn't make it; the next round asks R2 what's missing.
    case incomplete(String)
    case unexpected(String)

    /// Network trouble, 5xx answers and expired upload URLs can pass on a
    /// second try (which asks Convex for fresh URLs). A function error such as
    /// an invalid package won't.
    var isRetryable: Bool {
        switch self {
        case .network, .incomplete: return true
        case .http(let status, _, _): return status >= 500 || status == 429
        case .storage(_, let status): return status >= 500 || status == 403 || status == 408 || status == 429 || status == 0
        case .badURL, .convex, .unexpected: return false
        }
    }

    var errorDescription: String? {
        switch self {
        case .badURL(let base):
            return "\"\(base)\" isn't a usable Convex URL. Check it in Settings."
        case .network(let detail):
            return "Couldn't reach Braindance: \(detail)"
        case .http(let status, let function, let message):
            return "\(function) failed (HTTP \(status))" + (message.map { ": \($0)" } ?? ".")
        case .convex(_, _, let code, let details) where code == "invalid" && !details.isEmpty:
            return "The upload didn't check out: " + details.joined(separator: " ")
        case .convex(let function, let message, _, _):
            return "\(function): \(message)"
        case .storage(let file, let status):
            return status == 0 ? "\(file) didn't reach the storage server." : "The storage server refused \(file) (HTTP \(status))."
        case .incomplete(let detail):
            return "The upload isn't complete: \(detail)."
        case .unexpected(let detail):
            return "Braindance sent \(detail). The app and the server may be out of step."
        }
    }
}
