import XCTest
@testable import MeetingKit

final class EchoGateTests: XCTestCase {
    private let rate = 16_000

    /// Noise that is the same on every run.
    private func noise(seconds: Double, amplitude: Float, seed: UInt64) -> [Float] {
        var state = seed
        return (0..<Int(seconds * Double(rate))).map { _ in
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return amplitude * (Float(state >> 40) / Float(1 << 23) - 1)
        }
    }

    private func place(_ samples: [Float], at second: Double, in track: inout [Float]) {
        let start = Int(second * Double(rate))
        for (index, value) in samples.enumerated() where start + index < track.count {
            track[start + index] += value
        }
    }

    private func energy(_ samples: [Float], from start: Double, to end: Double) -> Float {
        let slice = Array(samples[Int(start * Double(rate))..<Int(end * Double(rate))])
        return AudioMath.rms(slice)
    }

    /// The remote side talks from 1 to 3 s and from 5 to 7 s; somebody in
    /// the room talks from 3.5 to 4.5 s and, over the call, from 6 to 6.5 s.
    private func scene(echoGain: Float, echoDelay: Double) -> (microphone: [Float], remote: [Float], room: [Float]) {
        var remote = [Float](repeating: 0, count: 8 * rate)
        place(noise(seconds: 2, amplitude: 0.3, seed: 1), at: 1, in: &remote)
        place(noise(seconds: 2, amplitude: 0.3, seed: 2), at: 5, in: &remote)
        var room = [Float](repeating: 0, count: 8 * rate)
        place(sine(frequency: 220, sampleRate: 16_000, seconds: 1, amplitude: 0.2), at: 3.5, in: &room)
        place(sine(frequency: 220, sampleRate: 16_000, seconds: 0.5, amplitude: 0.2), at: 6, in: &room)
        var microphone = room
        place(remote.map { $0 * echoGain }, at: echoDelay, in: &microphone)
        return (microphone, remote, room)
    }

    func testTheEchoIsSilencedAndTheRoomIsKept() {
        let scene = scene(echoGain: 0.35, echoDelay: 0.18)
        let (out, analysis) = EchoGate.suppress(microphone: scene.microphone, remote: scene.remote)
        XCTAssertEqual(out.count, scene.microphone.count)
        XCTAssertEqual(analysis.delaySeconds, 0.18, accuracy: 0.011)
        XCTAssertEqual(analysis.gain, 0.35, accuracy: 0.05)
        // only the remote side: gone
        XCTAssertGreaterThan(energy(scene.microphone, from: 1.3, to: 2.9), 0.05)
        XCTAssertEqual(energy(out, from: 1.3, to: 2.9), 0)
        XCTAssertEqual(energy(out, from: 5.3, to: 5.9), 0)
        // the tail of the echo after the remote side stopped
        XCTAssertEqual(energy(out, from: 3.0, to: 3.18), 0)
        // only the room: untouched, sample for sample
        XCTAssertEqual(Array(out[Int(3.6 * 16_000)..<Int(4.4 * 16_000)]), Array(scene.microphone[Int(3.6 * 16_000)..<Int(4.4 * 16_000)]))
        // the room talking over the call: louder than the echo would be, kept
        XCTAssertEqual(energy(out, from: 6.1, to: 6.4), energy(scene.microphone, from: 6.1, to: 6.4))
        XCTAssertGreaterThan(analysis.silencedShare, 0.4)
        XCTAssertLessThan(analysis.silencedShare, 0.6)
    }

    func testWithHeadphonesNothingTheRoomSaysIsTouched() {
        // no echo at all: the microphone only has the room and a little hiss
        var scene = scene(echoGain: 0, echoDelay: 0)
        let hiss = noise(seconds: 8, amplitude: 0.0005, seed: 3)
        scene.microphone = zip(scene.microphone, hiss).map { $0 + $1 }
        let (out, analysis) = EchoGate.suppress(microphone: scene.microphone, remote: scene.remote)
        XCTAssertLessThan(analysis.gain, 0.01)
        XCTAssertEqual(Array(out[Int(3.5 * 16_000)..<Int(4.5 * 16_000)]), Array(scene.microphone[Int(3.5 * 16_000)..<Int(4.5 * 16_000)]))
        XCTAssertEqual(Array(out[Int(6.0 * 16_000)..<Int(6.5 * 16_000)]), Array(scene.microphone[Int(6.0 * 16_000)..<Int(6.5 * 16_000)]),
                       "talking while the other side talks, with headphones on")
    }

    func testASilentRemoteSideLeavesTheMicrophoneAlone() {
        let microphone = sine(frequency: 300, sampleRate: 16_000, seconds: 3, amplitude: 0.2)
        let (out, analysis) = EchoGate.suppress(microphone: microphone, remote: [Float](repeating: 0, count: microphone.count))
        XCTAssertEqual(out, microphone)
        XCTAssertEqual(analysis.silencedShare, 0)
        // too short to say anything
        let short = Array(microphone.prefix(1000))
        XCTAssertEqual(EchoGate.suppress(microphone: short, remote: short).samples, short)
    }
}
