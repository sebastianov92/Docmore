import XCTest
@testable import MeetingKit

/// A device that the test plays by hand.
private final class FakeSource: AudioCaptureSource, @unchecked Sendable {
    let kind: AudioSource
    var onEnded: ((MeetingRecorderError) -> Void)?
    var startError: Error?
    private(set) var started = false
    private(set) var stopped = false
    private var handler: (([Float], Double) -> Void)?

    init(_ kind: AudioSource, startError: Error? = nil) {
        self.kind = kind
        self.startError = startError
    }

    func start(handler: @escaping ([Float], Double) -> Void) async throws {
        if let startError { throw startError }
        self.handler = handler
        started = true
    }

    func stop() {
        stopped = true
        handler = nil
    }

    /// Delivers audio the way a device does: in blocks.
    func deliver(_ samples: [Float], sampleRate: Double, blockSize: Int) {
        var offset = 0
        while offset < samples.count {
            let end = min(samples.count, offset + blockSize)
            handler?(Array(samples[offset..<end]), sampleRate)
            offset = end
        }
    }
}

/// Two devices running at the same time: a tenth of a second of one, a tenth
/// of a second of the other, and so on.
private func deliverTogether(
    _ first: FakeSource, _ firstSamples: [Float], _ firstRate: Double, _ firstBlock: Int,
    _ second: FakeSource, _ secondSamples: [Float], _ secondRate: Double, _ secondBlock: Int
) {
    let firstStep = Int(firstRate / 10)
    let secondStep = Int(secondRate / 10)
    var firstOffset = 0
    var secondOffset = 0
    while firstOffset < firstSamples.count || secondOffset < secondSamples.count {
        if firstOffset < firstSamples.count {
            let end = min(firstSamples.count, firstOffset + firstStep)
            first.deliver(Array(firstSamples[firstOffset..<end]), sampleRate: firstRate, blockSize: firstBlock)
            firstOffset = end
        }
        if secondOffset < secondSamples.count {
            let end = min(secondSamples.count, secondOffset + secondStep)
            second.deliver(Array(secondSamples[secondOffset..<end]), sampleRate: secondRate, blockSize: secondBlock)
            secondOffset = end
        }
    }
}

final class MeetingRecorderTests: XCTestCase {
    private func recorder(
        _ directory: URL,
        options: RecordingOptions = RecordingOptions(),
        microphone: FakeSource = FakeSource(.microphone),
        system: FakeSource = FakeSource(.systemAudio)
    ) -> MeetingRecorder {
        MeetingRecorder(outputDirectory: directory, options: options) { kind in
            kind == .microphone ? microphone : system
        }
    }

    func testMicrophoneOnlyRecordsA16kMonoWAV() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let recorder = recorder(directory, options: RecordingOptions(captureSystemAudio: false), microphone: microphone)
        let levels = Box<Float>()
        let chunks = Box<[Float]>()
        recorder.onLevel = { levels.add($0) }
        recorder.onChunk = { chunks.add($0) }

        try await recorder.start()
        XCTAssertTrue(recorder.isRecording)
        XCTAssertEqual(recorder.sources, [.microphone])
        XCTAssertEqual(recorder.warnings, [])
        // 3 s of a 440 Hz tone from a 48 kHz stereo-turned-mono device
        microphone.deliver(sine(frequency: 440, sampleRate: 48_000, seconds: 3), sampleRate: 48_000, blockSize: 4800)
        let result = try await recorder.stop()

        XCTAssertFalse(recorder.isRecording)
        XCTAssertTrue(microphone.stopped)
        XCTAssertEqual(result.sources, [.microphone])
        XCTAssertEqual(result.warnings, [])
        XCTAssertEqual(result.durationSeconds, 3, accuracy: 0.02)
        XCTAssertEqual(recorder.elapsed, result.durationSeconds, accuracy: 0.0001)
        XCTAssertEqual(result.fileURL.deletingLastPathComponent().path, directory.path)
        XCTAssertTrue(result.fileURL.lastPathComponent.hasPrefix("meeting-"))

        let audio = try WAVFile.read(result.fileURL)
        XCTAssertEqual(audio.sampleRate, 16_000)
        XCTAssertEqual(audio.channels, 1)
        XCTAssertEqual(audio.durationSeconds, result.durationSeconds, accuracy: 0.0001)
        XCTAssertEqual(AudioMath.rms(audio.samples), 0.5 / Float(2).squareRoot(), accuracy: 0.01)
        XCTAssertEqual(Double(risingZeroCrossings(audio.samples)) / 3, 440, accuracy: 3)

        // the callbacks got the same audio the file has
        XCTAssertEqual(chunks.values.reduce(0) { $0 + $1.count }, audio.samples.count)
        XCTAssertEqual(Double(chunks.count), 30, accuracy: 1, "ten chunks a second")
        XCTAssertTrue(chunks.values.dropLast().allSatisfy { $0.count == 1600 }, "0.1 s each")
        XCTAssertEqual(levels.count, chunks.count)
        // -9 dBFS on a -60...0 scale
        XCTAssertEqual(levels.values[levels.count / 2], 0.85, accuracy: 0.03)
    }

    func testTwoSourcesAtDifferentRatesAreMixed() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, microphone: microphone, system: system)
        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.microphone, .systemAudio])

        let voice = sine(frequency: 300, sampleRate: 44_100, seconds: 4, amplitude: 0.3)
        let call = sine(frequency: 1100, sampleRate: 48_000, seconds: 4, amplitude: 0.4)
        deliverTogether(microphone, voice, 44_100, 4410, system, call, 48_000, 512)
        let result = try await recorder.stop()

        XCTAssertEqual(result.sources, [.microphone, .systemAudio])
        XCTAssertEqual(result.warnings, [])
        XCTAssertEqual(result.durationSeconds, 4, accuracy: 0.03)
        let audio = try WAVFile.read(result.fileURL)
        // the energy of both tones: sqrt(0.3^2/2 + 0.4^2/2) = 0.3536
        XCTAssertEqual(AudioMath.rms(audio.samples), 0.3536, accuracy: 0.012)
    }

    func testRecordsTheMicrophoneWhenSystemAudioIsRefused() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio, startError: MeetingRecorderError.systemAudioPermissionDenied)
        let recorder = recorder(directory, microphone: microphone, system: system)

        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.microphone])
        XCTAssertEqual(recorder.warnings, [RecordingWarning(source: .systemAudio, error: .systemAudioPermissionDenied)])
        XCTAssertTrue(system.stopped, "a source that failed to start is cleaned up")

        microphone.deliver(sine(frequency: 440, sampleRate: 48_000, seconds: 2), sampleRate: 48_000, blockSize: 4800)
        let result = try await recorder.stop()
        XCTAssertEqual(result.sources, [.microphone])
        XCTAssertEqual(result.warnings.map(\.source), [.systemAudio])
        XCTAssertEqual(result.durationSeconds, 2, accuracy: 0.02, "one source is not delayed by the missing one")
        XCTAssertEqual(AudioMath.rms(try WAVFile.read(result.fileURL).samples), 0.3536, accuracy: 0.01)
    }

    func testRecordsSystemAudioWhenThereIsNoMicrophone() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone, startError: MeetingRecorderError.microphoneUnavailable("no input device is connected"))
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, microphone: microphone, system: system)
        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.systemAudio])
        system.deliver(sine(frequency: 500, sampleRate: 48_000, seconds: 1), sampleRate: 48_000, blockSize: 480)
        let result = try await recorder.stop()
        XCTAssertEqual(result.sources, [.systemAudio])
        XCTAssertEqual(result.warnings, [RecordingWarning(source: .microphone, error: .microphoneUnavailable("no input device is connected"))])
    }

    func testFailsCleanlyWhenNoSourceStarts() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone, startError: MeetingRecorderError.microphonePermissionDenied)
        let system = FakeSource(.systemAudio, startError: MeetingRecorderError.systemAudioUnavailable("no tap"))
        let recorder = recorder(directory, microphone: microphone, system: system)
        do {
            try await recorder.start()
            XCTFail("start() should throw")
        } catch {
            XCTAssertEqual(error as? MeetingRecorderError, .microphonePermissionDenied)
        }
        XCTAssertFalse(recorder.isRecording)
        XCTAssertEqual(recorder.warnings.map(\.source), [.microphone, .systemAudio])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [], "no empty file is left behind")
        // and the recorder can be used again
        microphone.startError = nil
        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.microphone])
        _ = try await recorder.stop()
    }

    func testAnUnknownErrorOfASourceBecomesAReadableOne() async throws {
        let directory = makeTemporaryDirectory(self)
        struct Odd: LocalizedError { var errorDescription: String? { "odd failure" } }
        let recorder = recorder(directory, options: RecordingOptions(captureMicrophone: false), system: FakeSource(.systemAudio, startError: Odd()))
        do {
            try await recorder.start()
            XCTFail("start() should throw")
        } catch {
            XCTAssertEqual(error as? MeetingRecorderError, .systemAudioUnavailable("odd failure"))
        }
    }

    func testStateErrors() async throws {
        let directory = makeTemporaryDirectory(self)
        let nothing = recorder(directory, options: RecordingOptions(captureMicrophone: false, captureSystemAudio: false))
        do { try await nothing.start(); XCTFail("should throw") } catch {
            XCTAssertEqual(error as? MeetingRecorderError, .nothingToRecord)
        }
        let recorder = recorder(directory)
        do { _ = try await recorder.stop(); XCTFail("should throw") } catch {
            XCTAssertEqual(error as? MeetingRecorderError, .notRecording)
        }
        try await recorder.start()
        do { try await recorder.start(); XCTFail("should throw") } catch {
            XCTAssertEqual(error as? MeetingRecorderError, .alreadyRecording)
        }
        XCTAssertTrue(recorder.isRecording, "the failed second start did not disturb the recording")
        await recorder.cancel()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [], "cancel deletes the file")
    }

    func testASilentSourceIsNotReportedAsCaptured() async throws {
        // what macOS gives when system audio recording is refused: zeros, no error
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, microphone: microphone, system: system)
        MeetingRecorder.usesPrivatePermissionCheck = false
        defer { MeetingRecorder.usesPrivatePermissionCheck = true }
        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.microphone, .systemAudio])
        deliverTogether(
            microphone, sine(frequency: 440, sampleRate: 48_000, seconds: 1), 48_000, 4800,
            system, [Float](repeating: 0, count: 48_000), 48_000, 512
        )
        let result = try await recorder.stop()
        XCTAssertEqual(result.sources, [.microphone])
        XCTAssertEqual(result.warnings, [RecordingWarning(source: .systemAudio, error: .silent(.systemAudio))])
        XCTAssertEqual(result.durationSeconds, 1, accuracy: 0.02)
        XCTAssertEqual(AudioMath.rms(try WAVFile.read(result.fileURL).samples), 0.3536, accuracy: 0.01, "the silent source takes nothing away")
    }

    func testTheFileIsReadableWhileRecording() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let recorder = recorder(directory, options: RecordingOptions(captureSystemAudio: false, fileName: "running.wav"), microphone: microphone)
        let delivered = Box<Int>()
        recorder.onChunk = { delivered.add($0.count) }
        try await recorder.start()
        microphone.deliver(sine(frequency: 440, sampleRate: 16_000, seconds: 5), sampleRate: 16_000, blockSize: 1600)
        // wait until the recorder's queue has written it
        for _ in 0..<200 where delivered.values.reduce(0, +) < 5 * 16_000 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        // a crash now would leave this file: valid, and with all the audio on disk
        let url = directory.appendingPathComponent("running.wav")
        let midway = try WAVFile.read(url)
        XCTAssertEqual(midway.durationSeconds, 5, accuracy: 0.01)
        let declared = try WAVFile.parse(try Data(contentsOf: url))
        XCTAssertGreaterThanOrEqual(declared.sampleRate, 16_000)
        let result = try await recorder.stop()
        XCTAssertEqual(result.fileURL.lastPathComponent, "running.wav")
        XCTAssertEqual(result.durationSeconds, 5, accuracy: 0.01)
    }

    func testASourceLostMidwayDoesNotStopTheOther() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, microphone: microphone, system: system)
        let failures = Box<MeetingRecorderError>()
        recorder.onFailure = { failures.add($0) }
        try await recorder.start()
        let voice = sine(frequency: 300, sampleRate: 16_000, seconds: 3, amplitude: 0.3)
        let call = sine(frequency: 1100, sampleRate: 16_000, seconds: 1, amplitude: 0.4)
        deliverTogether(microphone, Array(voice[0..<16_000]), 16_000, 1600, system, call, 16_000, 1600)
        // the output device goes away after one second
        system.onEnded?(.systemAudioUnavailable("the capture device stopped"))
        microphone.deliver(Array(voice[16_000...]), sampleRate: 16_000, blockSize: 1600)
        let result = try await recorder.stop()
        XCTAssertEqual(result.durationSeconds, 3, accuracy: 0.01, "the microphone kept recording, without waiting")
        XCTAssertEqual(result.sources, [.microphone, .systemAudio], "its first second is in the file")
        XCTAssertEqual(result.warnings, [RecordingWarning(source: .systemAudio, error: .systemAudioUnavailable("the capture device stopped"))])
        XCTAssertEqual(failures.count, 0, "one source is left: not a failure of the recording")
    }

    func testLosingEverySourceIsReported() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let recorder = recorder(directory, options: RecordingOptions(captureSystemAudio: false), microphone: microphone)
        let failures = Box<MeetingRecorderError>()
        recorder.onFailure = { failures.add($0) }
        try await recorder.start()
        microphone.deliver(sine(frequency: 300, sampleRate: 16_000, seconds: 1), sampleRate: 16_000, blockSize: 1600)
        microphone.onEnded?(.microphoneUnavailable("the input device was disconnected"))
        let result = try await recorder.stop()
        XCTAssertEqual(failures.values, [.microphoneUnavailable("the input device was disconnected")])
        XCTAssertEqual(result.durationSeconds, 1, accuracy: 0.01, "what was recorded is kept")
    }

    func testAudioBeforeStartReturnsIsNotRecorded() async throws {
        // start() of the second source can take long (a permission dialog)
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let recorder = recorder(directory, options: RecordingOptions(captureSystemAudio: false), microphone: microphone)
        try await recorder.start()
        let first = try await recorder.stop()
        XCTAssertEqual(first.durationSeconds, 0)
        XCTAssertEqual(first.sources, [], "nothing arrived: nothing was captured")
        XCTAssertEqual(first.warnings, [RecordingWarning(source: .microphone, error: .silent(.microphone))])
    }

    func testPermissionQueriesDoNotCrash() {
        // whatever the answer on this machine, it is one of the three and it never prompts
        XCTAssertTrue([.granted, .denied, .undetermined].contains(MeetingRecorder.microphonePermission()))
        XCTAssertTrue([.granted, .denied, .undetermined].contains(MeetingRecorder.systemAudioPermission()))
        MeetingRecorder.usesPrivatePermissionCheck = false
        XCTAssertEqual(MeetingRecorder.systemAudioPermission(), .undetermined)
        MeetingRecorder.usesPrivatePermissionCheck = true
    }

    func testCoreAudioStatusIsReadable() {
        XCTAssertEqual(SystemAudioCapture.describe(OSStatus(bitPattern: 0x216F626A)), "'!obj'")
        XCTAssertEqual(SystemAudioCapture.describe(-50), "-50")
    }
}
