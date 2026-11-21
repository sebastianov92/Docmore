import Foundation

/// A Whisper model WhisperKit can run.
public struct WhisperModelInfo: Identifiable, Hashable, Codable, Sendable {
    /// WhisperKit's identifier: the folder name in the
    /// `argmaxinc/whisperkit-coreml` repository ("openai_whisper-base").
    public let id: String
    /// Name for a menu ("Base").
    public let displayName: String
    /// Download size in bytes, rounded.
    public let approximateSizeBytes: Int64
    /// The Hugging Face repository that holds the tokenizer of this model
    /// ("openai/whisper-base"). WhisperKit loads it next to the model.
    public let tokenizerRepo: String
    /// One line about speed and quality.
    public let summary: String

    public init(id: String, displayName: String, approximateSizeBytes: Int64, tokenizerRepo: String, summary: String = "") {
        self.id = id
        self.displayName = displayName
        self.approximateSizeBytes = approximateSizeBytes
        self.tokenizerRepo = tokenizerRepo
        self.summary = summary
    }
}

/// The models MeetingKit offers. All are multilingual.
///
/// Sizes are the real sizes of the files in the repository (2026-11).
public enum WhisperModelCatalog {
    public static let tiny = WhisperModelInfo(
        id: "openai_whisper-tiny",
        displayName: "Tiny",
        approximateSizeBytes: 77_000_000,
        tokenizerRepo: "openai/whisper-tiny",
        summary: "Fastest, least accurate. Good for a quick test."
    )

    public static let base = WhisperModelInfo(
        id: "openai_whisper-base",
        displayName: "Base",
        approximateSizeBytes: 147_000_000,
        tokenizerRepo: "openai/whisper-base",
        summary: "Fast, fine for clear speech."
    )

    public static let small = WhisperModelInfo(
        id: "openai_whisper-small",
        displayName: "Small",
        approximateSizeBytes: 487_000_000,
        tokenizerRepo: "openai/whisper-small",
        summary: "Balanced speed and accuracy."
    )

    /// Large v3 turbo (the 2024-09-30 release), compressed to about 632 MB.
    public static let largeV3Turbo = WhisperModelInfo(
        id: "openai_whisper-large-v3-v20240930_turbo_632MB",
        displayName: "Large v3 Turbo",
        approximateSizeBytes: 646_000_000,
        tokenizerRepo: "openai/whisper-large-v3",
        summary: "Best accuracy for its size. Recommended on Apple Silicon."
    )

    /// Large v3 turbo (the 2024-09-30 release), full precision.
    public static let largeV3TurboFull = WhisperModelInfo(
        id: "openai_whisper-large-v3-v20240930_turbo",
        displayName: "Large v3 Turbo (full precision)",
        approximateSizeBytes: 1_638_000_000,
        tokenizerRepo: "openai/whisper-large-v3",
        summary: "Slightly more accurate than the compressed turbo, much larger."
    )

    /// From smallest to largest.
    public static let all: [WhisperModelInfo] = [tiny, base, small, largeV3Turbo, largeV3TurboFull]

    /// What the app should offer first.
    public static let recommended = largeV3Turbo

    /// Looks a model up by its identifier, or by a short name: "tiny",
    /// "base", "small", "turbo" (or "large-v3-turbo"), "turbo-full".
    public static func model(_ idOrAlias: String) -> WhisperModelInfo? {
        if let exact = all.first(where: { $0.id == idOrAlias }) { return exact }
        switch idOrAlias.lowercased() {
        case "tiny": return tiny
        case "base": return base
        case "small": return small
        case "turbo", "large-v3-turbo", "large-v3_turbo", "large": return largeV3Turbo
        case "turbo-full", "large-v3-turbo-full": return largeV3TurboFull
        default: return nil
        }
    }
}
