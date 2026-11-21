import Foundation

/// Picks the engine this build has. The MeetingKit adapter is compiled only
/// when the package is linked (see `packages` in project.yml).
@MainActor
enum MeetingEngineFactory {
    static func make() -> MeetingEngine {
        #if canImport(MeetingKit)
        return MeetingKitEngine(services: Services.shared)
        #else
        return UnavailableMeetingEngine()
        #endif
    }
}
