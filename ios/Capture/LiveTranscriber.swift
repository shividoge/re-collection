import CoreMedia
import Speech

/// Transcribes the moment's audio on the phone while it records, so the
/// transcript is ready at Stop. Audio arrives from the capture queue; results
/// arrive on the recognizer's own queue. Anything other than a clean final
/// result after Stop counts as a failure, and the caller falls back to
/// transcribing the saved audio. Nothing is guessed.
final class LiveTranscriber: @unchecked Sendable {
    let localeIdentifier: String
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private let recognizer: SFSpeechRecognizer
    private var task: SFSpeechRecognitionTask?

    private let lock = NSLock()
    // Guarded by `lock`.
    private var audioStart: Double?   // moment time of the first audio sample fed in
    private var ended = false
    private var outcome: Result<[TranscriptWord], Error>?
    private var waiter: CheckedContinuation<Result<[TranscriptWord], Error>, Never>?

    /// Nil when on-device recognition isn't available right now; the
    /// fallback then says why in the manifest warnings.
    static func start(localeIdentifier: String = "en-US") -> LiveTranscriber? {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)),
              recognizer.supportsOnDeviceRecognition, recognizer.isAvailable
        else { return nil }
        return LiveTranscriber(recognizer: recognizer, localeIdentifier: localeIdentifier)
    }

    private init(recognizer: SFSpeechRecognizer, localeIdentifier: String) {
        self.recognizer = recognizer
        self.localeIdentifier = localeIdentifier
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        recognizer.queue = queue
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.handle(result, error)
        }
    }

    /// Feeds one audio buffer (capture queue). `t0` is the moment's first
    /// video frame on the same clock, so word times line up with the video.
    func append(_ buffer: CMSampleBuffer, t0: TimeInterval) {
        let accepting = lock.withLock { () -> Bool in
            if audioStart == nil { audioStart = CMSampleBufferGetPresentationTimeStamp(buffer).seconds - t0 }
            return outcome == nil && !ended
        }
        if accepting { request.appendAudioSampleBuffer(buffer) }
    }

    /// Ends the audio and waits for the final result.
    func finish(timeout: TimeInterval = 30) async throws -> [TranscriptWord] {
        lock.withLock { ended = true }
        request.endAudio()
        let timer = DispatchWorkItem { [weak self] in
            self?.task?.cancel()
            self?.resolve(.failure(PostProcessError.transcript("live recognition took longer than \(Int(timeout)) s")))
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: timer)
        defer { timer.cancel() }

        let result = await withCheckedContinuation { (continuation: CheckedContinuation<Result<[TranscriptWord], Error>, Never>) in
            lock.lock()
            if let outcome {
                lock.unlock()
                continuation.resume(returning: outcome)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
        return try result.get()
    }

    /// The capture was abandoned.
    func cancel() {
        lock.withLock { ended = true }
        task?.cancel()
        resolve(.failure(CancellationError()))
    }

    private func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        let (stopped, start) = lock.withLock { (ended, audioStart ?? 0) }
        if !stopped, error != nil || result?.isFinal == true {
            // The recognizer gave up mid-visit; whatever it heard would be incomplete.
            resolve(.failure(PostProcessError.transcript("live recognition ended before the visit did")))
        } else if let error {
            resolve(PostProcessor.isNoSpeech(error) ? .success([]) : .failure(error))
        } else if let result, result.isFinal {
            resolve(.success(result.bestTranscription.segments.map {
                TranscriptWord(start: start + $0.timestamp, end: start + $0.timestamp + $0.duration, word: $0.substring)
            }))
        }
    }

    private func resolve(_ value: Result<[TranscriptWord], Error>) {
        lock.lock()
        guard outcome == nil else {
            lock.unlock()
            return
        }
        outcome = value
        let pending = self.waiter
        self.waiter = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}
