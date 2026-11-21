import XCTest
@testable import MeetingKit

final class MeetingProcessorTests: XCTestCase {
    // A call of a minute. The room: Ana opens, Luis proposes Friday. The
    // remote side: Marta agrees, Carlos prefers Monday. The loudspeakers
    // put Marta's sentence on the microphone as well.
    private let roomText = [
        timed("Hola a todos empezamos la reunión", 0.5, 4.5),
        timed("Me parece bien el viernes por la mañana", 5.7, 9.7),          // the echo of the remote side
        timed("Yo creo que entregamos el viernes", 10.5, 14.5),
    ]
    private let remoteText = [
        timed("Me parece bien el viernes por la mañana", 5.5, 9.5),
        timed("Mejor el lunes que el viernes", 15.5, 19.5),
    ]
    private let roomVoices: [(Double, Double, Int)] = [(0.5, 4.5, 0), (5.7, 9.7, 2), (10.5, 14.5, 1)]
    private let remoteVoices: [(Double, Double, Int)] = [(5.5, 9.5, 0), (15.5, 19.5, 1)]

    private var tracks: MeetingTracks {
        MeetingTracks(room: ScriptedAudio.track(0, seconds: 60), remote: ScriptedAudio.track(1, seconds: 60))
    }

    private func processor(_ transcriber: ScriptedTranscriber, _ diarizer: SampleDiarizing?) -> MeetingProcessor {
        var options = MeetingProcessingOptions()
        options.usesEchoGate = false     // the audio here is made up: only its text and its turns mean anything
        return MeetingProcessor(transcriber: transcriber, diarizer: diarizer, options: options)
    }

    func testAVirtualMeetingBecomesOneTranscriptWithSidesAndSpeakers() async throws {
        let transcriber = ScriptedTranscriber([roomText, remoteText])
        let diarizer = ScriptedDiarizer([roomVoices, remoteVoices])
        let progress = Box<Double>()
        let result = try await processor(transcriber, diarizer).process(tracks, mode: .virtual) { progress.add($0) }
        let transcript = result.transcript

        XCTAssertEqual(transcript.mode, .virtual)
        XCTAssertEqual(transcript.language, "es")
        XCTAssertEqual(transcript.durationSeconds, 60)
        // the two tracks by time, the echo gone
        XCTAssertEqual(transcript.segments.map(\.text), [
            "Hola a todos empezamos la reunión",
            "Me parece bien el viernes por la mañana",
            "Yo creo que entregamos el viernes",
            "Mejor el lunes que el viernes",
        ])
        XCTAssertEqual(transcript.segments.map(\.side), [.room, .remote, .room, .remote])
        XCTAssertEqual(transcript.segments.map(\.start), [0.5, 5.5, 10.5, 15.5])
        XCTAssertEqual(transcript.text, transcript.segments.map(\.text).joined(separator: " "))
        // speakers numbered by first appearance over both tracks; the voice of the loudspeaker is nobody
        XCTAssertEqual(transcript.segments.map(\.speaker), ["s1", "s2", "s3", "s4"])
        XCTAssertEqual(transcript.speakers, [
            MeetingSpeaker(id: "s1", number: 1, side: .room),
            MeetingSpeaker(id: "s2", number: 2, side: .remote),
            MeetingSpeaker(id: "s3", number: 3, side: .room),
            MeetingSpeaker(id: "s4", number: 4, side: .remote),
        ])
        XCTAssertEqual(result.echoes.map(\.text), ["Me parece bien el viernes por la mañana"])
        XCTAssertEqual(result.echoes.first?.side, .room)
        XCTAssertEqual(result.notes, [])

        // the state that goes with the recording knows the same speakers
        XCTAssertEqual(result.state.speakers, transcript.speakers)
        XCTAssertEqual(result.state.tracks[0].voices.map(\.id), ["s1", "s3"])
        XCTAssertEqual(result.state.tracks[1].voices.map(\.id), ["s2", "s4"])
        XCTAssertEqual(result.state.nextNumber, 5)

        // each track was transcribed and diarized once; the second with the language of the first
        XCTAssertEqual(transcriber.snapshot.map(\.track), [0, 1])
        XCTAssertEqual(transcriber.snapshot.map(\.language), [nil, "es"])
        XCTAssertEqual(diarizer.snapshot.map(\.track), [0, 1])
        XCTAssertEqual(progress.values.first, 0)
        XCTAssertEqual(progress.values.last, 1)
        XCTAssertEqual(progress.values, progress.values.sorted())
    }

    func testTheSpeakersOfTheLiveSessionKeepIdsNumbersAndNames() async throws {
        // what the live session knew when the recording stopped: Ana (s1) in
        // the room and, named by the person, Marta (s2) on the call. Numbers
        // 3 and 4 went to voices that are gone.
        var seed = MeetingSpeakerState(
            mode: .virtual,
            speakers: [MeetingSpeaker(id: "s1", number: 1, side: .room), MeetingSpeaker(id: "s2", number: 2, side: .remote, name: "Marta")],
            nextNumber: 5,
            tracks: [
                TrackSpeakers(side: .room, voices: [KnownVoice(id: "s1", print: voicePrint(0), printSeconds: 4)],
                              turns: [.init(start: 0.6, end: 4.4, speaker: "s1")]),
                TrackSpeakers(side: .remote, voices: [KnownVoice(id: "s2", print: voicePrint(5), printSeconds: 4)],
                              turns: [.init(start: 5.6, end: 9.4, speaker: "s2")]),
            ]
        )
        seed.setName("Marta", for: "s2")
        let result = try await processor(ScriptedTranscriber([roomText, remoteText]), ScriptedDiarizer([roomVoices, remoteVoices]))
            .process(tracks, mode: .virtual, state: seed)

        XCTAssertEqual(result.transcript.segments.map(\.speaker), ["s1", "s2", "s5", "s6"])
        XCTAssertEqual(result.transcript.speakers, [
            MeetingSpeaker(id: "s1", number: 1, side: .room),
            MeetingSpeaker(id: "s2", number: 2, side: .remote, name: "Marta"),
            MeetingSpeaker(id: "s5", number: 5, side: .room),
            MeetingSpeaker(id: "s6", number: 6, side: .remote),
        ])
    }

    func testASpeakerOfTheLiveSessionWithNoTextLeftIsDropped() async throws {
        // the live session had taken the loudspeaker for a person in the room and somebody had named it
        let seed = MeetingSpeakerState(
            mode: .virtual,
            speakers: [MeetingSpeaker(id: "s1", number: 1, side: .room), MeetingSpeaker(id: "s2", number: 2, side: .room, name: "Echo")],
            nextNumber: 3,
            tracks: [
                TrackSpeakers(side: .room, voices: [KnownVoice(id: "s1"), KnownVoice(id: "s2")],
                              turns: [.init(start: 0.5, end: 4.5, speaker: "s1"), .init(start: 5.7, end: 9.7, speaker: "s2")]),
                TrackSpeakers(side: .remote),
            ]
        )
        let result = try await processor(ScriptedTranscriber([roomText, remoteText]), ScriptedDiarizer([roomVoices, remoteVoices]))
            .process(tracks, mode: .virtual, state: seed)
        XCTAssertEqual(result.transcript.speakers.map(\.id), ["s1", "s3", "s4", "s5"])
        XCTAssertFalse(result.transcript.speakers.contains { $0.name == "Echo" })
        XCTAssertEqual(result.transcript.segments.map(\.speaker), ["s1", "s3", "s4", "s5"])
        XCTAssertEqual(result.echoes.count, 1)
    }

    func testWithoutSpeakerModelsEverySegmentStillHasItsSide() async throws {
        // no diarizer at all
        var result = try await processor(ScriptedTranscriber([roomText, remoteText]), nil).process(tracks, mode: .virtual)
        XCTAssertEqual(result.transcript.speakers, [])
        XCTAssertTrue(result.transcript.segments.allSatisfy { $0.speaker == nil })
        XCTAssertEqual(result.transcript.segments.map(\.side), [.room, .remote, .room, .remote])
        XCTAssertEqual(result.echoes.count, 1, "the echo pass needs no speakers")
        XCTAssertEqual(result.notes, [])
        XCTAssertEqual(result.transcript.mode, .virtual)

        // a diarizer whose models are not on disk: the same, with a word to the person
        let diarizer = ScriptedDiarizer([roomVoices, remoteVoices])
        diarizer.available = false
        result = try await processor(ScriptedTranscriber([roomText, remoteText]), diarizer).process(tracks, mode: .virtual)
        XCTAssertEqual(result.transcript.speakers, [])
        XCTAssertTrue(result.transcript.segments.allSatisfy { $0.speaker == nil && $0.side != nil })
        XCTAssertEqual(result.notes.count, 1)
        XCTAssertTrue(result.notes[0].contains("speaker models"))
        XCTAssertEqual(diarizer.snapshot.count, 0, "nothing was asked of it")
    }

    func testAOneTrackRecordingHasNoSidesWhateverModeIsAsked() async throws {
        let transcriber = ScriptedTranscriber([roomText])
        let diarizer = ScriptedDiarizer([roomVoices])
        // a recording of the first version: one mixed channel
        let old = MeetingTracks(room: ScriptedAudio.track(0, seconds: 60))
        let result = try await processor(transcriber, diarizer).process(old, mode: .virtual)
        XCTAssertEqual(result.transcript.mode, .inPerson)
        XCTAssertTrue(result.transcript.segments.allSatisfy { $0.side == nil })
        XCTAssertEqual(result.transcript.segments.count, 3, "no remote track: nothing is an echo")
        XCTAssertEqual(result.transcript.speakers.map(\.id), ["s1", "s2", "s3"])
        XCTAssertTrue(result.transcript.speakers.allSatisfy { $0.side == nil })
        XCTAssertEqual(result.notes.count, 1)
        XCTAssertEqual(result.state.tracks.count, 1)

        // asked as in person: the same, without the note
        let inPerson = try await processor(ScriptedTranscriber([roomText]), ScriptedDiarizer([roomVoices])).process(old, mode: .inPerson)
        XCTAssertEqual(inPerson.transcript.segments, result.transcript.segments)
        XCTAssertEqual(inPerson.notes, [])

        // a live state made for a virtual meeting does not fit it and is left aside
        let seeded = try await processor(ScriptedTranscriber([roomText]), ScriptedDiarizer([roomVoices]))
            .process(old, mode: .inPerson, state: MeetingSpeakerState(mode: .virtual))
        XCTAssertEqual(seeded.transcript.speakers.map(\.id), ["s1", "s2", "s3"])
        XCTAssertEqual(seeded.notes.count, 1)
    }

    func testASilentTrackIsNotWorkedOn() async throws {
        let transcriber = ScriptedTranscriber([roomText, remoteText])
        let diarizer = ScriptedDiarizer([roomVoices, remoteVoices])
        // system audio was recorded but nothing ever played
        let quiet = MeetingTracks(room: ScriptedAudio.track(0, seconds: 60), remote: [Float](repeating: 0, count: 60 * 16_000))
        let result = try await processor(transcriber, diarizer).process(quiet, mode: .virtual)
        XCTAssertEqual(transcriber.snapshot.map(\.track), [0])
        XCTAssertEqual(diarizer.snapshot.map(\.track), [0])
        XCTAssertEqual(result.transcript.mode, .virtual)
        XCTAssertEqual(result.transcript.segments.map(\.side), [.room, .room, .room])
        XCTAssertEqual(result.echoes, [])
    }

    func testATrackWhoseVoicesCannotBeToldApartKeepsItsText() async throws {
        let diarizer = ScriptedDiarizer([roomVoices, remoteVoices])
        diarizer.failingCalls = [1]      // the remote track
        let result = try await processor(ScriptedTranscriber([roomText, remoteText]), diarizer).process(tracks, mode: .virtual)
        XCTAssertEqual(result.transcript.segments.map(\.side), [.room, .remote, .room, .remote])
        XCTAssertEqual(result.transcript.segments.map(\.speaker), ["s1", nil, "s2", nil])
        XCTAssertEqual(result.transcript.speakers.map(\.side), [.room, .room])
        XCTAssertEqual(result.notes.count, 1)
        XCTAssertTrue(result.notes[0].contains("remote track"))
    }

    func testAnInPersonMeetingRecordedOnTwoChannelsIsOneTrack() async throws {
        final class Counting: WordTranscribing, @unchecked Sendable {
            var sizes: [Int] = []
            func transcribeWords(samples: [Float], language: String?) async throws -> TimedTranscript {
                sizes.append(samples.count)
                return TimedTranscript(language: "es", durationSeconds: 2, segments: [.init(start: 0, end: 1, text: "todo junto")])
            }
        }
        let transcriber = Counting()
        let both = MeetingTracks(room: [Float](repeating: 0.1, count: 32_000), remote: [Float](repeating: 0.2, count: 32_000))
        let result = try await MeetingProcessor(transcriber: transcriber, diarizer: nil).process(both, mode: .inPerson)
        XCTAssertEqual(transcriber.sizes, [32_000], "the two channels as one")
        XCTAssertEqual(result.transcript.mode, .inPerson)
        XCTAssertEqual(result.transcript.segments, [.init(start: 0, end: 1, text: "todo junto")])
        // nothing to transcribe at all
        let nothing = try await MeetingProcessor(transcriber: transcriber, diarizer: nil).process(MeetingTracks(room: []), mode: .inPerson)
        XCTAssertTrue(nothing.transcript.isEmpty)
        XCTAssertEqual(transcriber.sizes.count, 1)
    }

    func testTheSameRecordingGivesTheSameTranscript() async throws {
        var results: [MeetingTranscript] = []
        for _ in 0..<3 {
            let result = try await processor(ScriptedTranscriber([roomText, remoteText]), ScriptedDiarizer([roomVoices, remoteVoices]))
                .process(tracks, mode: .virtual)
            results.append(result.transcript)
        }
        XCTAssertEqual(results[0], results[1])
        XCTAssertEqual(results[1], results[2])
    }
}
