import Foundation

/// Puts the tracks of a meeting together: the step the live session and the
/// final pass share, so both give the same transcript for the same input.
enum MeetingAssembler {
    struct Assembly {
        /// Both tracks merged by time.
        var segments: [MeetingTranscript.Segment]
        /// What the echo pass took out of the room track.
        var echoes: [MeetingTranscript.Segment]
        /// Ids that have text, in order of first appearance.
        var speakersInOrder: [String]
    }

    /// - Parameter tracks: the labelled segments of each track, the room
    ///   (or the only track) first.
    static func assemble(tracks: [[LabelledSegment]], removeEcho: Bool, echoPolicy: EchoFilter.Policy) -> Assembly {
        var kept = tracks
        var echoes: [LabelledSegment] = []
        if removeEcho, tracks.count >= 2 {
            let result = EchoFilter.removeEcho(room: tracks[0], remote: tracks[1], policy: echoPolicy)
            kept[0] = result.kept
            echoes = result.dropped
        }
        let merged = MeetingTranscript.ordered(kept.flatMap { $0.map(\.plain) })
        var order: [String] = []
        for segment in merged {
            if let speaker = segment.speaker, !order.contains(speaker) { order.append(speaker) }
        }
        return Assembly(segments: merged, echoes: echoes.map(\.plain), speakersInOrder: order)
    }
}
