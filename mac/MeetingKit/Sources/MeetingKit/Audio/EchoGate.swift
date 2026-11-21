import Accelerate
import Foundation

/// Silences, in a copy of the microphone track, the moments that are only
/// the remote side coming out of the loudspeakers.
///
/// It is not an echo canceller and nothing that is transcribed goes through
/// it: the copy is only what the speaker models listen to, so that the
/// voices of the call are not taken for people in the room. The text of the
/// room track is still made from the untouched microphone, and the echo of
/// the remote sentences is removed from it as text (`EchoFilter`).
///
/// How: both tracks are cut in frames of 10 ms. The delay of the
/// loudspeaker path is the shift at which the loudness of the two tracks
/// agrees best; the level of the echo is the typical ratio between the
/// microphone and the remote track while the remote side talks. A
/// microphone frame is silenced when the remote side is talking (or has
/// just stopped: the room rings on) and the microphone is no louder than
/// that echo would be. Somebody in the room talking over the call is
/// louder than the echo and is kept. With headphones there is no echo, the
/// ratio is tiny and only the room's background noise is silenced.
public enum EchoGate {
    public struct Analysis: Equatable, Sendable {
        /// Delay of the microphone behind the remote track, in seconds.
        public var delaySeconds: Double
        /// Level of the echo relative to the remote track (amplitude). Near
        /// zero with headphones.
        public var gain: Double
        /// Share of the microphone frames that were silenced.
        public var silencedShare: Double
    }

    static let frame = MeetingAudioFormat.sampleRateInt / 100
    /// Remote frames quieter than this (about -55 dBFS) are silence.
    static let activeEnergy: Float = 3e-6
    static let maxDelayFrames = 50
    /// How long after the remote side stops a frame can still be its echo.
    static let tailFrames = 25
    /// How much louder than the expected echo the microphone has to be to
    /// count as somebody in the room talking (6 dB).
    static let margin: Float = 4

    /// The microphone with the echo of `remote` silenced, and what was found.
    public static func suppress(microphone: [Float], remote: [Float]) -> (samples: [Float], analysis: Analysis) {
        let count = min(microphone.count, remote.count) / frame
        guard count > maxDelayFrames + 1 else {
            return (microphone, Analysis(delaySeconds: 0, gain: 0, silencedShare: 0))
        }
        let own = energies(microphone, frames: count)
        let far = energies(remote, frames: count)
        guard far.contains(where: { $0 > activeEnergy }) else {
            return (microphone, Analysis(delaySeconds: 0, gain: 0, silencedShare: 0))
        }

        // The delay: where the loudness of the two tracks lines up best.
        let ownLevel = own.map { $0.squareRoot() }
        let farLevel = far.map { $0.squareRoot() }
        var delay = 0
        var best: Float = -1
        for shift in 0...maxDelayFrames {
            var sum: Float = 0
            vDSP_dotpr(Array(farLevel[0..<(count - shift)]), 1, Array(ownLevel[shift..<count]), 1, &sum, vDSP_Length(count - shift))
            if sum > best {
                best = sum
                delay = shift
            }
        }

        // The echo level: the typical microphone/remote energy ratio while the remote side talks.
        var ratios: [Float] = []
        for index in 0..<(count - delay) where far[index] > activeEnergy {
            ratios.append(own[index + delay] / far[index])
        }
        guard !ratios.isEmpty else {
            return (microphone, Analysis(delaySeconds: 0, gain: 0, silencedShare: 0))
        }
        ratios.sort()
        let ratio = ratios[ratios.count / 2]

        // The loudest the remote side has been over the last quarter of a second, delayed.
        var out = microphone
        var silenced = 0
        for index in 0..<count {
            let source = index - delay
            guard source >= 0 else { continue }
            var recent: Float = 0
            var back = 0
            while back <= tailFrames, source - back >= 0 {
                recent = max(recent, far[source - back])
                back += 1
            }
            guard recent > activeEnergy, own[index] <= margin * ratio * recent else { continue }
            let start = index * frame
            for sample in start..<(start + frame) {
                out[sample] = 0
            }
            silenced += 1
        }
        return (out, Analysis(
            delaySeconds: Double(delay * frame) / MeetingAudioFormat.sampleRate,
            gain: Double(ratio.squareRoot()),
            silencedShare: Double(silenced) / Double(count)
        ))
    }

    /// Mean square of each 10 ms frame.
    static func energies(_ samples: [Float], frames: Int) -> [Float] {
        var out = [Float](repeating: 0, count: frames)
        samples.withUnsafeBufferPointer { buffer in
            for index in 0..<frames {
                var value: Float = 0
                vDSP_measqv(buffer.baseAddress! + index * frame, 1, &value, vDSP_Length(frame))
                out[index] = value
            }
        }
        return out
    }
}
