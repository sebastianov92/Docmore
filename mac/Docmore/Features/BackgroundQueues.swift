import Foundation

/// Work that waits for a server: quick notes and meeting transcripts. Kicked
/// at launch and each time a server becomes reachable.
@MainActor
final class BackgroundQueues {
    static let shared = BackgroundQueues()

    func kick() {
        QuickCapture.shared.flush()
        MeetingController.shared.flushQueue()
        MeetingController.shared.finishInterruptedRecordings()
    }
}
