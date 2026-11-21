import AVFoundation
import XCTest
@testable import MeetingKit

/// A device that the test plays by hand.
private final class FakeSource: AudioCaptureSource, @unchecked Sendable {
    let kind: AudioSource
    var onEnded: ((MeetingRecorderError) -> Void)?
    var startError: Error?
    private(set) var started = false
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
        handler = nil
    }

    func deliver(_ samples: [Float], sampleRate: Double, blockSize: Int) {
        var offset = 0
        while offset < samples.count {
            let end = min(samples.count, offset + blockSize)
            handler?(Array(samples[offset..<end]), sampleRate)
            offset = end
        }
    }
}

/// Two devices running at the same time, a tenth of a second each in turn.
private func deliverTogether(_ first: FakeSource, _ firstSamples: [Float], _ firstRate: Double,
                             _ second: FakeSource, _ secondSamples: [Float], _ secondRate: Double) {
    let firstStep = Int(firstRate / 10)
    let secondStep = Int(secondRate / 10)
    var firstOffset = 0
    var secondOffset = 0
    while firstOffset < firstSamples.count || secondOffset < secondSamples.count {
        if firstOffset < firstSamples.count {
            let end = min(firstSamples.count, firstOffset + firstStep)
            first.deliver(Array(firstSamples[firstOffset..<end]), sampleRate: firstRate, blockSize: 512)
            firstOffset = end
        }
        if secondOffset < secondSamples.count {
            let end = min(secondSamples.count, secondOffset + secondStep)
            second.deliver(Array(secondSamples[secondOffset..<end]), sampleRate: secondRate, blockSize: 441)
            secondOffset = end
        }
    }
}

final class SeparateTracksTests: XCTestCase {
    private func recorder(_ directory: URL, options: RecordingOptions, microphone: FakeSource, system: FakeSource) -> MeetingRecorder {
        MeetingRecorder(outputDirectory: directory, options: options) { kind in
            kind == .microphone ? microphone : system
        }
    }

    func testOptionsOfTheTwoKindsOfMeeting() {
        let virtual = RecordingOptions(mode: .virtual)
        XCTAssertTrue(virtual.captureMicrophone && virtual.captureSystemAudio && virtual.keepsTracksApart)
        XCTAssertEqual(virtual.mode, .virtual)
        let inPerson = RecordingOptions(mode: .inPerson, fileName: "a.wav")
        XCTAssertTrue(inPerson.captureMicrophone)
        XCTAssertFalse(inPerson.captureSystemAudio)
        XCTAssertFalse(inPerson.keepsTracksApart)
        XCTAssertEqual(inPerson.fileName, "a.wav")
        // the options of the first version still mean one mixed channel
        let mixed = RecordingOptions()
        XCTAssertNil(mixed.mode)
        XCTAssertTrue(mixed.captureMicrophone && mixed.captureSystemAudio)
        XCTAssertFalse(mixed.keepsTracksApart)
    }

    func testAVirtualMeetingKeepsTheTwoSourcesInTwoAlignedChannels() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, options: RecordingOptions(mode: .virtual), microphone: microphone, system: system)
        let chunks = Box<MeetingAudioChunk>()
        let mixed = Box<[Float]>()
        recorder.onTrackChunk = { chunks.add($0) }
        recorder.onChunk = { mixed.add($0) }

        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.microphone, .systemAudio])
        // the room: a 440 Hz tone from a 48 kHz microphone; the call: 1000 Hz from a 44.1 kHz output
        deliverTogether(microphone, sine(frequency: 440, sampleRate: 48_000, seconds: 3, amplitude: 0.5), 48_000,
                        system, sine(frequency: 1000, sampleRate: 44_100, seconds: 3, amplitude: 0.3), 44_100)
        let result = try await recorder.stop()

        XCTAssertEqual(result.mode, .virtual)
        XCTAssertEqual(result.sources, [.microphone, .systemAudio])
        XCTAssertEqual(result.warnings, [])
        XCTAssertEqual(result.durationSeconds, 3, accuracy: 0.03)

        let audio = try WAVFile.readChannels(result.fileURL)
        XCTAssertEqual(audio.sampleRate, 16_000)
        XCTAssertEqual(audio.channels.count, 2)
        XCTAssertEqual(audio.channels[0].count, audio.channels[1].count)
        XCTAssertEqual(audio.durationSeconds, result.durationSeconds, accuracy: 0.0001)
        // channel 0 is the microphone and nothing else, channel 1 the system audio and nothing else
        let seconds = audio.durationSeconds
        XCTAssertEqual(Double(risingZeroCrossings(audio.channels[0])) / seconds, 440, accuracy: 4)
        XCTAssertEqual(Double(risingZeroCrossings(audio.channels[1])) / seconds, 1000, accuracy: 8)
        XCTAssertEqual(AudioMath.rms(audio.channels[0]), 0.5 / Float(2).squareRoot(), accuracy: 0.01)
        XCTAssertEqual(AudioMath.rms(audio.channels[1]), 0.3 / Float(2).squareRoot(), accuracy: 0.01)

        // the live chunks: both tracks, same length, the same audio the file has
        let delivered = chunks.values
        XCTAssertTrue(delivered.allSatisfy { $0.systemAudio != nil && $0.systemAudio!.count == $0.microphone.count })
        XCTAssertTrue(delivered.dropLast().allSatisfy { $0.microphone.count == 1600 })
        let liveRoom = delivered.flatMap(\.microphone)
        let liveRemote = delivered.flatMap { $0.systemAudio ?? [] }
        XCTAssertEqual(liveRoom.count, audio.channels[0].count)
        XCTAssertEqual(AudioMath.rms(liveRoom), AudioMath.rms(audio.channels[0]), accuracy: 0.001)
        XCTAssertEqual(Double(risingZeroCrossings(liveRemote)) / seconds, 1000, accuracy: 8)
        // the old callback still gets something: the two tracks added up
        XCTAssertEqual(mixed.values.reduce(0) { $0 + $1.count }, liveRoom.count)
        XCTAssertGreaterThan(AudioMath.rms(mixed.values.flatMap { $0 }), AudioMath.rms(liveRoom))

        // what the rest of MeetingKit makes of the file
        XCTAssertEqual(AudioTrackReader.channelCount(of: result.fileURL), 2)
        XCTAssertEqual(AudioTrackReader.recordedMode(of: result.fileURL), .virtual)
        let tracks = try MeetingTracks(contentsOf: result.fileURL)
        XCTAssertEqual(tracks.room.count, audio.channels[0].count)
        XCTAssertEqual(tracks.remote?.count, audio.channels[1].count)
        XCTAssertEqual(Double(risingZeroCrossings(tracks.remote ?? [])) / seconds, 1000, accuracy: 8)
        // and any player
        let file = try AVAudioFile(forReading: result.fileURL)
        XCTAssertEqual(file.fileFormat.channelCount, 2)
        XCTAssertEqual(file.fileFormat.sampleRate, 16_000)
    }

    func testAVirtualMeetingWithoutSystemAudioHasASilentSecondChannel() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio, startError: MeetingRecorderError.systemAudioPermissionDenied)
        let recorder = recorder(directory, options: RecordingOptions(mode: .virtual), microphone: microphone, system: system)
        let chunks = Box<MeetingAudioChunk>()
        recorder.onTrackChunk = { chunks.add($0) }

        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.microphone])
        XCTAssertEqual(recorder.warnings, [RecordingWarning(source: .systemAudio, error: .systemAudioPermissionDenied)])
        microphone.deliver(sine(frequency: 440, sampleRate: 48_000, seconds: 2), sampleRate: 48_000, blockSize: 4800)
        let result = try await recorder.stop()

        XCTAssertEqual(result.mode, .virtual)
        XCTAssertEqual(result.sources, [.microphone])
        let audio = try WAVFile.readChannels(result.fileURL)
        XCTAssertEqual(audio.channels.count, 2, "the layout of the file does not depend on what started")
        XCTAssertEqual(Double(risingZeroCrossings(audio.channels[0])) / audio.durationSeconds, 440, accuracy: 4)
        XCTAssertEqual(AudioMath.peak(audio.channels[1]), 0)
        XCTAssertTrue(chunks.values.allSatisfy { $0.systemAudio != nil && AudioMath.peak($0.systemAudio!) == 0 })
    }

    func testSystemAudioAloneGoesToTheSecondChannel() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone, startError: MeetingRecorderError.microphonePermissionDenied)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, options: RecordingOptions(mode: .virtual), microphone: microphone, system: system)
        try await recorder.start()
        system.deliver(sine(frequency: 1000, sampleRate: 48_000, seconds: 1), sampleRate: 48_000, blockSize: 4800)
        let result = try await recorder.stop()
        let audio = try WAVFile.readChannels(result.fileURL)
        XCTAssertEqual(AudioMath.peak(audio.channels[0]), 0, "the remote side is never written to the room's channel")
        XCTAssertEqual(Double(risingZeroCrossings(audio.channels[1])) / audio.durationSeconds, 1000, accuracy: 8)
    }

    func testAnInPersonMeetingRecordsTheMicrophoneAlone() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, options: RecordingOptions(mode: .inPerson), microphone: microphone, system: system)
        let chunks = Box<MeetingAudioChunk>()
        recorder.onTrackChunk = { chunks.add($0) }
        try await recorder.start()
        XCTAssertEqual(recorder.sources, [.microphone])
        XCTAssertFalse(system.started, "system audio is not even asked for")
        microphone.deliver(sine(frequency: 440, sampleRate: 16_000, seconds: 1), sampleRate: 16_000, blockSize: 1600)
        let result = try await recorder.stop()

        XCTAssertEqual(result.mode, .inPerson)
        XCTAssertEqual(result.warnings, [])
        XCTAssertEqual(AudioTrackReader.channelCount(of: result.fileURL), 1)
        XCTAssertEqual(AudioTrackReader.recordedMode(of: result.fileURL), .inPerson)
        XCTAssertNil(try MeetingTracks(contentsOf: result.fileURL).remote)
        XCTAssertTrue(chunks.values.allSatisfy { $0.systemAudio == nil })
        XCTAssertEqual(chunks.values.flatMap(\.microphone).count, 16_000)
    }

    func testTheMixedLayoutOfTheFirstVersionIsStillThere() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, options: RecordingOptions(), microphone: microphone, system: system)
        let chunks = Box<MeetingAudioChunk>()
        recorder.onTrackChunk = { chunks.add($0) }
        try await recorder.start()
        deliverTogether(microphone, sine(frequency: 440, sampleRate: 16_000, seconds: 2, amplitude: 0.3), 16_000,
                        system, sine(frequency: 1000, sampleRate: 16_000, seconds: 2, amplitude: 0.3), 16_000)
        let result = try await recorder.stop()

        XCTAssertNil(result.mode)
        XCTAssertEqual(result.sources, [.microphone, .systemAudio])
        XCTAssertEqual(AudioTrackReader.channelCount(of: result.fileURL), 1)
        // a recording like the ones the first version made: one track, no sides
        let tracks = try MeetingTracks(contentsOf: result.fileURL)
        XCTAssertNil(tracks.remote)
        XCTAssertEqual(tracks.durationSeconds, 2, accuracy: 0.02)
        XCTAssertEqual(AudioTrackReader.recordedMode(of: result.fileURL), .inPerson)
        XCTAssertTrue(chunks.values.allSatisfy { $0.systemAudio == nil }, "one channel, one track")
    }

    func testALateSourceIsFilledWithSilenceSoTheChannelsStayTheSameLength() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let system = FakeSource(.systemAudio)
        let recorder = recorder(directory, options: RecordingOptions(mode: .virtual), microphone: microphone, system: system)
        try await recorder.start()
        // the microphone runs alone for a second (the system has nothing to play yet) ...
        microphone.deliver(sine(frequency: 440, sampleRate: 16_000, seconds: 1), sampleRate: 16_000, blockSize: 1600)
        // ... then both
        deliverTogether(microphone, sine(frequency: 440, sampleRate: 16_000, seconds: 2), 16_000,
                        system, sine(frequency: 1000, sampleRate: 16_000, seconds: 2), 16_000)
        let result = try await recorder.stop()
        let audio = try WAVFile.readChannels(result.fileURL)
        XCTAssertEqual(audio.channels[0].count, audio.channels[1].count)
        XCTAssertEqual(audio.durationSeconds, 3, accuracy: 0.01)
        // the recorder does not wait more than half a second for a source: the first 0.4 s of the system channel are silence
        XCTAssertEqual(AudioMath.peak(Array(audio.channels[1].prefix(6_400))), 0)
        XCTAssertGreaterThan(AudioMath.rms(Array(audio.channels[1][9_600..<38_400])), 0.3, "then its two seconds of tone")
        XCTAssertGreaterThan(AudioMath.rms(Array(audio.channels[0].prefix(6_400))), 0.2)
    }

    func testATwoTrackRecordingCutByACrashIsRepaired() throws {
        let directory = makeTemporaryDirectory(self)
        let url = directory.appendingPathComponent("crashed.wav")
        let writer = try WAVWriter(url: url, sampleRate: 16_000, channels: 2)
        // 2.5 s: the header on disk was last refreshed at 2 s
        let room = sine(frequency: 440, sampleRate: 16_000, seconds: 2.5, amplitude: 0.4)
        let remote = sine(frequency: 1000, sampleRate: 16_000, seconds: 2.5, amplitude: 0.2)
        var offset = 0
        while offset < room.count {
            let end = min(room.count, offset + 1600)
            try writer.append(RecordingPipeline.interleave([Array(room[offset..<end]), Array(remote[offset..<end])]))
            offset = end
        }
        // the crash: the bytes as they are now, plus half a frame that was being written
        let crashed = directory.appendingPathComponent("crashed-copy.wav")
        var bytes = try Data(contentsOf: url)
        bytes.append(contentsOf: [0x12, 0x34])
        try bytes.write(to: crashed)

        // readable as it is (the stale header is tolerated) ...
        XCTAssertEqual(try WAVFile.readChannels(crashed).channels.count, 2)
        // ... and exact after the repair
        let seconds = try WAVFile.repairHeader(at: crashed)
        XCTAssertEqual(seconds, 2.5, accuracy: 0.0001)
        let audio = try WAVFile.readChannels(crashed)
        XCTAssertEqual(audio.channels.map(\.count), [40_000, 40_000])
        XCTAssertEqual(Double(risingZeroCrossings(audio.channels[0])) / 2.5, 440, accuracy: 2)
        XCTAssertEqual(Double(risingZeroCrossings(audio.channels[1])) / 2.5, 1000, accuracy: 2)
        XCTAssertEqual(AudioTrackReader.recordedMode(of: crashed), .virtual)
        let file = try AVAudioFile(forReading: crashed)
        XCTAssertEqual(file.fileFormat.channelCount, 2)
        XCTAssertEqual(file.length, 40_000)
        try writer.finish()
    }

    func testReadingTracks() throws {
        let directory = makeTemporaryDirectory(self)
        // two separate files of different length become two tracks of the same length
        let first = directory.appendingPathComponent("microphone.wav")
        let second = directory.appendingPathComponent("system.wav")
        var writer = try WAVWriter(url: first, sampleRate: 16_000, channels: 1)
        try writer.append(sine(frequency: 440, sampleRate: 16_000, seconds: 2))
        try writer.finish()
        writer = try WAVWriter(url: second, sampleRate: 16_000, channels: 1)
        try writer.append(sine(frequency: 1000, sampleRate: 16_000, seconds: 1.5))
        try writer.finish()
        let tracks = try MeetingTracks(microphone: first, systemAudio: second)
        XCTAssertEqual(tracks.room.count, 32_000)
        XCTAssertEqual(tracks.remote?.count, 32_000)
        XCTAssertEqual(tracks.durationSeconds, 2)
        XCTAssertEqual(AudioMath.peak(Array((tracks.remote ?? []).suffix(7_000))), 0, "the shorter one is padded with silence")
        XCTAssertEqual(tracks.mixed.count, 32_000)
        XCTAssertNil(try MeetingTracks(microphone: first, systemAudio: nil).remote)
        // one channel of a file, or the mix of all
        XCTAssertEqual(try AudioTrackReader.samples(of: first, channel: 0).count, 32_000)
        XCTAssertThrowsError(try AudioTrackReader.samples(of: first, channel: 1))
        XCTAssertEqual(AudioTrackReader.mixdown([[1, 1], [0, 0.5]]), [0.5, 0.75])
        XCTAssertEqual(AudioTrackReader.channelCount(of: directory.appendingPathComponent("missing.wav")), 0)
        XCTAssertNil(AudioTrackReader.recordedMode(of: directory.appendingPathComponent("missing.wav")))
    }

    func testTheSpeakerModelsAreNotDownloadedWhileARecordingRuns() async throws {
        let directory = makeTemporaryDirectory(self)
        let microphone = FakeSource(.microphone)
        let recorder = recorder(directory, options: RecordingOptions(mode: .inPerson), microphone: microphone, system: FakeSource(.systemAudio))
        let store = ModelStore(directory: directory.appendingPathComponent("models"))
        XCTAssertFalse(RecordingActivity.isRecording)

        try await recorder.start()
        XCTAssertTrue(RecordingActivity.isRecording)
        do {
            try await store.download(SpeakerModelCatalog.recommended)
            XCTFail("the download must be refused")
        } catch {
            XCTAssertEqual(error as? ModelStoreError, .recordingInProgress)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.directory.path), "nothing was even created")
        microphone.deliver(sine(frequency: 440, sampleRate: 16_000, seconds: 0.5), sampleRate: 16_000, blockSize: 1600)
        _ = try await recorder.stop()
        XCTAssertFalse(RecordingActivity.isRecording)

        // a recording that is cancelled frees it as well
        try await recorder.start()
        XCTAssertTrue(RecordingActivity.isRecording)
        await recorder.cancel()
        XCTAssertFalse(RecordingActivity.isRecording)
    }
}
