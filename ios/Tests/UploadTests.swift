import Foundation
import XCTest
@testable import BraindanceCapture

final class UploadPlanTests: XCTestCase {
    func testClaudesInputsGoFirstBigFilesLastAndRoomPlyStaysOnThePhone() {
        let order = UploadPlan.order([
            "depth.bin", "video.mp4", "keyframes/k0001.jpg", "manifest.json", "depth.index.json",
            "frames.jsonl", "thumb.jpg", "room.bin", "keyframes/k0000.jpg", "transcript.json", "room.ply", ".DS_Store",
            "keyframes/._k0000.jpg", "capture.zip",
        ])
        XCTAssertEqual(order, [
            "manifest.json", "thumb.jpg", "transcript.json", "keyframes/k0000.jpg", "keyframes/k0001.jpg",
            "room.bin", "frames.jsonl", "video.mp4", "depth.index.json", "depth.bin",
        ])
    }

    func testURLsAreBuiltFromWhateverWasTyped() {
        XCTAssertEqual(UploadPlan.url(base: "https://adamant-schnauzer-171.convex.cloud/", path: "/api/mutation")?.absoluteString,
                       "https://adamant-schnauzer-171.convex.cloud/api/mutation")
        XCTAssertEqual(UploadPlan.url(base: " adamant-schnauzer-171.convex.cloud ", path: "/api/action")?.absoluteString,
                       "https://adamant-schnauzer-171.convex.cloud/api/action")
        XCTAssertEqual(UploadPlan.url(base: "http://192.168.1.20:3210", path: "/api/query")?.absoluteString,
                       "http://192.168.1.20:3210/api/query")
        XCTAssertNil(UploadPlan.url(base: "  ", path: "/api/query"))
    }

    func testContentTypes() {
        XCTAssertEqual(UploadPlan.contentType(for: "manifest.json"), "application/json")
        XCTAssertEqual(UploadPlan.contentType(for: "depth.index.json"), "application/json")
        XCTAssertEqual(UploadPlan.contentType(for: "frames.jsonl"), "application/x-ndjson")
        XCTAssertEqual(UploadPlan.contentType(for: "keyframes/k0003.jpg"), "image/jpeg")
        XCTAssertEqual(UploadPlan.contentType(for: "video.mp4"), "video/mp4")
        XCTAssertEqual(UploadPlan.contentType(for: "depth.bin"), "application/octet-stream")
    }

    func testPartRanges() {
        let mib: Int64 = 1 << 20
        XCTAssertEqual(UploadPlan.partRange(partNumber: 1, partSize: 8 * mib, bytes: 20 * mib), 0..<(8 * mib))
        XCTAssertEqual(UploadPlan.partRange(partNumber: 3, partSize: 8 * mib, bytes: 20 * mib), (16 * mib)..<(20 * mib))
        XCTAssertNil(UploadPlan.partRange(partNumber: 4, partSize: 8 * mib, bytes: 20 * mib))
        XCTAssertNil(UploadPlan.partRange(partNumber: 0, partSize: 8 * mib, bytes: 20 * mib))
        XCTAssertEqual(UploadPlan.partRange(partNumber: 2, partSize: 10, bytes: 20), 10..<20)   // exact fit
        XCTAssertNil(UploadPlan.partRange(partNumber: 3, partSize: 10, bytes: 20))
    }

    func testPiecesFromAMultipartTarget() throws {
        let target = UploadTarget(uploadId: "u1", key: "captures/c/raw/video.mp4", partSize: 10, parts: [
            .init(partNumber: 1, url: "https://r2.example/p1"),
            .init(partNumber: 3, url: "https://r2.example/p3"),
        ])
        let pieces = try UploadPlan.pieces(for: target, bytes: 25)
        XCTAssertEqual(pieces.map(\.partNumber), [1, 3])
        XCTAssertEqual(pieces.map(\.range), [0..<10, 20..<25])
        XCTAssertEqual(pieces[1].url.absoluteString, "https://r2.example/p3")
        XCTAssertEqual(pieces[0].headers, [:])
    }

    func testPieceFromASingleTarget() throws {
        let target = UploadTarget(uploadId: "u2", key: "k", single: .init(url: "https://r2.example/s", headers: ["Content-Type": "image/jpeg"]))
        let pieces = try UploadPlan.pieces(for: target, bytes: 1234)
        XCTAssertEqual(pieces, [UploadPlan.Piece(partNumber: nil, url: URL(string: "https://r2.example/s")!,
                                                 headers: ["Content-Type": "image/jpeg"], range: 0..<1234)])
    }

    func testTargetsThatDontFitTheFileAreRejected() {
        let noParts = UploadTarget(uploadId: "u", key: "k")
        XCTAssertThrowsError(try UploadPlan.pieces(for: noParts, bytes: 10))
        let tooMany = UploadTarget(uploadId: "u", key: "k", partSize: 10, parts: [.init(partNumber: 3, url: "https://r2.example/p3")])
        XCTAssertThrowsError(try UploadPlan.pieces(for: tooMany, bytes: 15))
        let noSize = UploadTarget(uploadId: "u", key: "k", parts: [.init(partNumber: 1, url: "https://r2.example/p1")])
        XCTAssertThrowsError(try UploadPlan.pieces(for: noSize, bytes: 15))
    }

    func testMissingParts() {
        let done = [FinishedPart(partNumber: 1, etag: "a"), FinishedPart(partNumber: 3, etag: "c")]
        XCTAssertEqual(UploadPlan.missingParts(done, partSize: 10, bytes: 35), [2, 4])
        XCTAssertEqual(UploadPlan.missingParts(done + [.init(partNumber: 2, etag: "b")], partSize: 10, bytes: 30), [])
    }
}

final class ConvexClientTests: XCTestCase {
    private struct Captured: Decodable, Equatable { var captureId: String }

    func testSuccessGivesTheValue() throws {
        let data = Data(#"{"status":"success","value":{"captureId":"abc"},"logLines":[]}"#.utf8)
        let value: Captured = try ConvexClient.parse(data, status: 200, path: "captures:begin")
        XCTAssertEqual(value, Captured(captureId: "abc"))
    }

    func testFunctionErrorsKeepTheirMessage() {
        let data = Data(#"{"status":"error","errorMessage":"Uncaught Error: no such capture","logLines":[]}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(data, status: 560, path: "uploads:start") as Captured) { error in
            XCTAssertEqual(error as? UploadError, .convex(function: "uploads:start", message: "Uncaught Error: no such capture", code: nil, details: [], retryable: false))
            XCTAssertFalse((error as? UploadError)?.isRetryable ?? true)
        }
    }

    func testInvalidPackageListsWhatsWrong() {
        let data = Data(#"{"status":"error","errorMessage":"invalid","errorData":{"code":"invalid","errors":["depth.bin is 10 bytes, expected 20."]}}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(data, status: 560, path: "captures:complete") as Captured) { error in
            XCTAssertEqual(error.localizedDescription, "The upload didn't check out: depth.bin is 10 bytes, expected 20.")
        }
    }

    func testOddErrorDataStillGivesTheMessage() {
        let data = Data(#"{"status":"error","errorMessage":"boom","errorData":"just a string"}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(data, status: 560, path: "uploads:finish") as Captured) { error in
            XCTAssertEqual(error as? UploadError, .convex(function: "uploads:finish", message: "boom", code: nil, details: [], retryable: false))
        }
    }

    func testTheBackendDecidesWhetherAFunctionErrorIsRetried() {
        let storage = Data(#"{"status":"error","errorMessage":"storage","errorData":{"code":"storage","message":"R2 list failed: HTTP 503","retryable":true}}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(storage, status: 560, path: "uploads:resume") as Captured) { error in
            XCTAssertEqual(error as? UploadError, .convex(function: "uploads:resume", message: "storage", code: "storage", details: [], retryable: true))
            XCTAssertTrue((error as? UploadError)?.isRetryable ?? false)
        }
        let refused = Data(#"{"status":"error","errorMessage":"claude","errorData":{"code":"claude","message":"bad request","retryable":false}}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(refused, status: 560, path: "uploads:resume") as Captured) { error in
            XCTAssertFalse((error as? UploadError)?.isRetryable ?? true)
        }
        // No `retryable` (not_found, invalid) means no.
        let gone = Data(#"{"status":"error","errorMessage":"gone","errorData":{"code":"not_found","message":"No upload u1."}}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(gone, status: 560, path: "uploads:resume") as Captured) { error in
            XCTAssertEqual(error as? UploadError, .convex(function: "uploads:resume", message: "gone", code: "not_found", details: [], retryable: false))
            XCTAssertFalse((error as? UploadError)?.isRetryable ?? true)
        }
        // A `retryable` that isn't a Bool is ignored, not a reason to fail parsing.
        let odd = Data(#"{"status":"error","errorMessage":"odd","errorData":{"code":"storage","retryable":"yes"}}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(odd, status: 560, path: "uploads:resume") as Captured) { error in
            XCTAssertEqual(error as? UploadError, .convex(function: "uploads:resume", message: "odd", code: "storage", details: [], retryable: false))
        }
    }

    func testErrorsOutsideAFunction() {
        let data = Data(#"{"code":"BadJsonBody","message":"Failed to parse"}"#.utf8)
        XCTAssertThrowsError(try ConvexClient.parse(data, status: 400, path: "captures:begin") as Captured) { error in
            XCTAssertEqual(error as? UploadError, .http(status: 400, function: "captures:begin", message: "Failed to parse"))
            XCTAssertFalse((error as? UploadError)?.isRetryable ?? true)
        }
        XCTAssertThrowsError(try ConvexClient.parse(Data("<html>".utf8), status: 503, path: "captures:begin") as Captured) { error in
            XCTAssertTrue((error as? UploadError)?.isRetryable ?? false)
        }
    }

    func testExpiredURLsAndNetworkTroubleAreRetried() {
        XCTAssertTrue(UploadError.storage(file: "video.mp4 part 2", status: 403).isRetryable)
        XCTAssertTrue(UploadError.storage(file: "video.mp4", status: 500).isRetryable)
        XCTAssertFalse(UploadError.storage(file: "video.mp4", status: 400).isRetryable)
        XCTAssertTrue(UploadError.network("offline").isRetryable)
        XCTAssertTrue(UploadError.incomplete("x").isRetryable)
    }

    func testRequestBodyMatchesTheHTTPAPI() throws {
        // The shape Convex expects: { path, args, format }.
        struct Call: Encodable { let path: String; let args: ConvexAPI.Finish; let format = "json" }
        let body = try JSONEncoder().encode(Call(path: "uploads:finish", args: .init(uploadId: "u", parts: nil)))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["path"] as? String, "uploads:finish")
        XCTAssertEqual(json["format"] as? String, "json")
        let args = try XCTUnwrap(json["args"] as? [String: Any])
        XCTAssertEqual(args["uploadId"] as? String, "u")
        XCTAssertNil(args["parts"])   // omitted, not null, for a single PUT
    }
}

final class UploaderResumeTests: XCTestCase {
    private func convex(_ code: String?, retryable: Bool) -> UploadError {
        .convex(function: "uploads:resume", message: "m", code: code, details: [], retryable: retryable)
    }

    func testOnlyAGoneUploadStartsTheFileOver() {
        // The backend says the old upload is gone or finished: start a new one.
        XCTAssertTrue(Uploader.shouldRestart(afterResumeFailed: convex("not_found", retryable: false)))
        XCTAssertTrue(Uploader.shouldRestart(afterResumeFailed: convex("invalid", retryable: false)))
        XCTAssertTrue(Uploader.shouldRestart(afterResumeFailed: convex("storage", retryable: false)))   // R2 NoSuchUpload
        XCTAssertTrue(Uploader.shouldRestart(afterResumeFailed: convex(nil, retryable: false)))
    }

    func testPassingTroubleKeepsTheUploadAndItsParts() {
        XCTAssertFalse(Uploader.shouldRestart(afterResumeFailed: convex("storage", retryable: true)))
        XCTAssertFalse(Uploader.shouldRestart(afterResumeFailed: UploadError.network("offline")))
        XCTAssertFalse(Uploader.shouldRestart(afterResumeFailed: UploadError.http(status: 503, function: "uploads:resume", message: nil)))
        XCTAssertFalse(Uploader.shouldRestart(afterResumeFailed: CancellationError()))
        // Not the backend saying the upload is gone, so it isn't thrown away either.
        XCTAssertFalse(Uploader.shouldRestart(afterResumeFailed: UploadError.http(status: 400, function: "uploads:resume", message: nil)))
        XCTAssertFalse(Uploader.shouldRestart(afterResumeFailed: UploadError.unexpected("x")))
    }
}

final class UploadJobTests: XCTestCase {
    private func file(_ name: String, _ bytes: Int64, _ modified: Double = 1) -> UploadJob.File {
        UploadJob.File(name: name, bytes: bytes, modified: modified)
    }

    func testUnchangedFilesKeepTheirProgress() {
        var job = UploadJob(convexURL: "https://a.convex.cloud", manifestId: "m", folderName: "capture-m", captureId: "c",
                            files: [file("manifest.json", 100), file("video.mp4", 1000)])
        job.files[0].finished = true
        job.files[1].uploadId = "u-video"

        let same = job.reconciled(with: [file("manifest.json", 100), file("video.mp4", 1000)], convexURL: "https://a.convex.cloud")
        XCTAssertEqual(same, job)
    }

    func testAnEditedFileStartsOverAndOthersDont() {
        var job = UploadJob(convexURL: "https://a.convex.cloud", manifestId: "m", folderName: "capture-m", captureId: "c",
                            files: [file("manifest.json", 100), file("video.mp4", 1000)])
        job.files[0].finished = true
        job.files[1].uploadId = "u-video"

        // The title was edited: manifest.json changed size and time; a new keyframe appeared.
        let next = job.reconciled(with: [file("manifest.json", 120, 2), file("keyframes/k0000.jpg", 50), file("video.mp4", 1000)],
                                  convexURL: "https://a.convex.cloud")
        XCTAssertEqual(next.captureId, "c")
        XCTAssertEqual(next.files.map(\.name), ["manifest.json", "keyframes/k0000.jpg", "video.mp4"])
        XCTAssertFalse(next.files[0].finished)
        XCTAssertNil(next.files[1].uploadId)
        XCTAssertEqual(next.files[2].uploadId, "u-video")

        // Same size but touched also counts as changed.
        XCTAssertNil(job.reconciled(with: [file("manifest.json", 100), file("video.mp4", 1000, 5)], convexURL: job.convexURL).files[1].uploadId)
    }

    func testAnotherDeploymentMeansAFreshJob() {
        var job = UploadJob(convexURL: "https://a.convex.cloud", manifestId: "m", folderName: "capture-m", captureId: "c",
                            files: [file("manifest.json", 100)])
        job.files[0].finished = true
        let next = job.reconciled(with: [file("manifest.json", 100)], convexURL: "https://b.convex.cloud")
        XCTAssertNil(next.captureId)
        XCTAssertFalse(next.files[0].finished)
        XCTAssertEqual(next.convexURL, "https://b.convex.cloud")
    }

    func testStoreSavesLoadsCutsAndRemoves() throws {
        let store = UploadJobStore(manifestId: "test-\(UUID().uuidString)")
        defer { store.remove() }
        let job = UploadJob(convexURL: "https://a.convex.cloud", manifestId: store.manifestId, folderName: "capture-x", captureId: nil,
                            files: [file("video.mp4", 25)])
        try store.save(job)
        XCTAssertEqual(store.load(), job)
        XCTAssertTrue(UploadJobStore.pendingJobs().contains(job))

        let source = FileManager.default.temporaryDirectory.appendingPathComponent("cut-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: source) }
        try Data((0..<25).map { UInt8($0) }).write(to: source)
        let part = store.partURL(file: 0, part: 3)
        try store.cut(source, range: 20..<25, to: part)
        XCTAssertEqual(try Data(contentsOf: part), Data([20, 21, 22, 23, 24]))
        store.removeParts(file: 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))

        store.remove()
        XCTAssertNil(store.load())
    }
}
