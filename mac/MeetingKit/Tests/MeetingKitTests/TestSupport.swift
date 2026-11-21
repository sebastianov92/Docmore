import Foundation
import XCTest
@testable import MeetingKit

/// A fresh directory under the system's temporary folder, removed at the end
/// of the test.
func makeTemporaryDirectory(_ test: XCTestCase, function: String = #function) -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("MeetingKitTests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    test.addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
}

func sine(frequency: Double, sampleRate: Double, seconds: Double, amplitude: Float = 0.5) -> [Float] {
    let count = Int(sampleRate * seconds)
    return (0..<count).map { amplitude * Float(sin(2 * Double.pi * frequency * Double($0) / sampleRate)) }
}

/// Times the signal crosses zero going up: the frequency for a clean tone.
func risingZeroCrossings(_ samples: [Float]) -> Int {
    var count = 0
    for index in 1..<samples.count where samples[index - 1] < 0 && samples[index] >= 0 {
        count += 1
    }
    return count
}

func sampleTranscript() -> MeetingTranscript {
    MeetingTranscript(
        segments: [
            .init(start: 0, end: 1.5, text: "Hello there."),
            .init(start: 1.5, end: 3, text: "General Kenobi."),
        ],
        language: "en",
        durationSeconds: 3
    )
}

/// Collects values from callbacks that run on other threads.
final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Value] = []

    func add(_ value: Value) {
        lock.lock()
        stored.append(value)
        lock.unlock()
    }

    var values: [Value] {
        lock.lock(); defer { lock.unlock() }
        return stored
    }

    var count: Int { values.count }
}
