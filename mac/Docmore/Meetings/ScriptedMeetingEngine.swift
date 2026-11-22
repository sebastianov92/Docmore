#if DEBUG
import Foundation

/// An engine double for developing and checking the meeting panel without a
/// microphone: it "records" a scripted meeting. Lines arrive over time from
/// several voices (on both sides in a virtual meeting), and at one point a
/// voice the engine had taken for another gets its earlier line relabelled,
/// the way real speaker identification corrects itself.
///
/// Recording and transcription are scripted; models and the queue are the
/// real engine's, so the transcript of a scripted meeting travels to the
/// server like any other. Reached only through the automation server.
@MainActor
final class ScriptedMeetingEngine: MeetingEngine {
    struct Options {
        /// "es" or "en": the language the meeting is "spoken" in.
        var language = "es"
        /// Lines per second of real time are `speed / 4`.
        var speed = 1.0
        /// Adds a very long line and a word that cannot be broken.
        var stress = false
        /// A WAV to use as the audio of the recording (copied); a second of
        /// silence when nil.
        var audio: URL?
    }

    private struct Line {
        let voice: Int
        let es: String
        let en: String
    }

    private static let script: [Line] = [
        Line(voice: 0, es: "Buenos días a todos, empezamos la revisión semanal del lanzamiento.", en: "Good morning everyone, let's start the weekly review of the launch."),
        Line(voice: 2, es: "Por mi parte, la página de precios ya está lista para revisión.", en: "On my side, the pricing page is ready for review."),
        Line(voice: 1, es: "Perfecto. Entonces acordamos lanzar el viernes 28 de noviembre.", en: "Great. Then we agree to launch on Friday, November 28."),
        Line(voice: 3, es: "Yo preparo las notas de la versión antes del jueves.", en: "I will write the release notes before Thursday."),
        Line(voice: 0, es: "Luis, ¿puedes actualizar la documentación de la API esta semana?", en: "Luis, can you update the API documentation this week?"),
        Line(voice: 1, es: "Sí, la actualizo mañana mismo.", en: "Yes, I will update it tomorrow."),
        Line(voice: 2, es: "Una cosa: el viernes es feriado en Chile, mejor movemos el lanzamiento al lunes.", en: "One thing: Friday is a holiday in Chile, we had better move the launch to Monday."),
        Line(voice: 0, es: "De acuerdo, entonces lanzamos el lunes 1 de diciembre y no el viernes.", en: "Agreed, then we launch on Monday, December 1, and not on Friday."),
        Line(voice: 3, es: "Y cancelamos la demo interna del miércoles, ya no hace falta.", en: "And we cancel Wednesday's internal demo, it is no longer needed."),
        Line(voice: 1, es: "Hecho. ¿Algo más antes de terminar?", en: "Done. Anything else before we finish?"),
        Line(voice: 2, es: "Nada más por mi lado, gracias a todos.", en: "Nothing else from me, thank you all."),
    ]

    private static let stressLines: [Line] = [
        Line(
            voice: 1,
            es: "Antes de cerrar quiero dejar constancia, con todo el detalle posible, de que la migración de la base de datos de clientes se hará por etapas, empezando por las cuentas de prueba, siguiendo con las cuentas internas y terminando con los clientes de pago, y de que en cada etapa vamos a comparar los totales de registros, los importes facturados y las fechas de alta contra el sistema anterior antes de dar el siguiente paso, para que nadie tenga que deshacer nada a mano un domingo por la noche.",
            en: "Before we close I want it on record, in as much detail as possible, that the migration of the customer database will be done in stages, starting with the test accounts, then the internal accounts and finally the paying customers, and that at every stage we will compare record totals, invoiced amounts and sign-up dates against the old system before taking the next step, so that nobody has to undo anything by hand on a Sunday night."
        ),
        Line(
            voice: 3,
            es: "El identificador es cliente_facturacion_migracion_etapa_tres_verificacion_importes_2026_11_28_definitivo.",
            en: "The identifier is customer_billing_migration_stage_three_amount_verification_2026_11_28_final."
        ),
    ]

    /// The voice the script takes for another until this line arrives.
    private static let lateVoice = 3
    private static let mistakenFor = 2
    private static let correctedAtLine = 8

    private let base: MeetingEngine
    private let options: Options
    private var mode = MeetingMode.inPerson
    private var lines: [Line] = []
    private var played = 0
    private var corrected = false
    private var timer: Timer?
    private var levelTimer: Timer?
    private var file: URL?
    private var onLive: (@Sendable (MeetingLiveUpdate) -> Void)?
    private var onLevel: (@Sendable (MeetingLevels) -> Void)?
    private var levelStep = 0
    private var speakerModelOnDisk: Bool
    /// True for the double Settings is looked at with: the transcription
    /// models are then the real engine's, and the speaker model starts as
    /// not downloaded.
    private let forSettings: Bool

    init(base: MeetingEngine, options: Options = Options(), forSettings: Bool = false) {
        self.base = base
        self.options = options
        self.forSettings = forSettings
        speakerModelOnDisk = !forSettings
    }

    // MARK: The script

    private func voice(_ index: Int) -> MeetingSpeaker {
        // voices 0 and 1 sit in the room, 2 and 3 are on the call
        let remote = index >= 2
        switch mode {
        case .virtual:
            return MeetingSpeaker(id: remote ? "remote-\(index - 1)" : "room-\(index + 1)", number: 0, side: remote ? .remote : .room)
        case .inPerson:
            return MeetingSpeaker(id: "voice-\(index + 1)", number: 0, side: nil)
        }
    }

    /// Who the engine thinks said a line: the late voice passes for another
    /// until it is told apart.
    private func heardVoice(_ line: Line) -> Int {
        line.voice == Self.lateVoice && !corrected ? Self.mistakenFor : line.voice
    }

    private func segment(_ index: Int) -> MeetingSegment {
        let line = lines[index]
        let speaker = voice(heardVoice(line))
        let text = options.language == "en" ? line.en : line.es
        let start = 2 + Double(index) * 6
        return MeetingSegment(start: start, end: start + min(5.5, 1.5 + Double(text.count) / 18), text: text, speaker: speaker.id, side: speaker.side)
    }

    /// The voices heard so far, numbered in order of first appearance.
    private func speakers(upTo count: Int) -> [MeetingSpeaker] {
        var seen: [MeetingSpeaker] = []
        for index in 0..<count {
            var speaker = voice(heardVoice(lines[index]))
            guard !seen.contains(where: { $0.id == speaker.id }) else { continue }
            speaker.number = seen.count + 1
            seen.append(speaker)
        }
        return seen
    }

    private func playNext() {
        guard played < lines.count, let onLive else {
            timer?.invalidate()
            timer = nil
            return
        }
        let index = played
        played += 1
        if index == Self.correctedAtLine, !corrected {
            // the late voice is told apart now: its earlier lines change speaker
            corrected = true
            let first = lines[..<index].firstIndex { $0.voice == Self.lateVoice } ?? index
            onLive(MeetingLiveUpdate(fromIndex: first, segments: (first...index).map(segment), speakers: speakers(upTo: played)))
        } else {
            onLive(MeetingLiveUpdate(fromIndex: index, segments: [segment(index)], speakers: speakers(upTo: played)))
        }
    }

    /// Plays what is left of the script at once.
    func advance() {
        while played < lines.count { playNext() }
    }

    var linesPlayed: Int { played }
    var linesTotal: Int { lines.count }

    private func emitLevel() {
        levelStep += 1
        let wave = Float(0.35 + 0.3 * sin(Double(levelStep) / 3.0))
        let speaking = played > 0 ? lines[min(played, lines.count) - 1].voice : 0
        let remoteSpeaks = speaking >= 2
        switch mode {
        case .virtual:
            onLevel?(MeetingLevels(room: remoteSpeaks ? 0.04 : wave, remote: remoteSpeaks ? wave : 0.03))
        case .inPerson:
            onLevel?(MeetingLevels(room: wave, remote: nil))
        }
    }

    // MARK: Recording

    var recordingsDirectory: URL { base.recordingsDirectory }

    func startRecording(
        _ request: MeetingRecordingRequest,
        onLevel: @escaping @Sendable (MeetingLevels) -> Void,
        onLive: @escaping @Sendable (MeetingLiveUpdate) -> Void,
        onFailure: @escaping @Sendable (String) -> Void
    ) async throws -> [String] {
        mode = request.mode
        lines = Self.script + (options.stress ? Self.stressLines : [])
        played = 0
        corrected = false
        self.onLive = onLive
        self.onLevel = onLevel
        let target = recordingsDirectory.appendingPathComponent(request.fileName)
        if let audio = options.audio {
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.copyItem(at: audio, to: target)
        } else {
            try Self.silentWAV(seconds: 1).write(to: target)
        }
        file = target
        let interval = 4 / max(0.05, options.speed)
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.playNext() }
        }
        levelTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.emitLevel() }
        }
        return []
    }

    private func stopTimers() {
        timer?.invalidate()
        timer = nil
        levelTimer?.invalidate()
        levelTimer = nil
        onLive = nil
        onLevel = nil
    }

    func stopRecording() async throws -> MeetingRecordingResult {
        guard let file else { throw MeetingEngineError(message: "no scripted recording is running") }
        stopTimers()
        return MeetingRecordingResult(fileURL: file, durationSeconds: 2 + Double(played) * 6, warnings: [])
    }

    func cancelRecording() async {
        stopTimers()
        if let file { removeRecording(at: file) }
        file = nil
    }

    func repairRecording(at file: URL) {
        base.repairRecording(at: file)
    }

    func recordedMode(of file: URL) -> MeetingMode? {
        file == self.file ? mode : base.recordedMode(of: file)
    }

    // the script has no voices to keep track of: the app's own state holds the names
    func setSpeakerName(_ name: String?, for speakerId: String) {}

    func removeRecording(at file: URL) {
        try? FileManager.default.removeItem(at: file)
    }

    /// 16 kHz mono 16-bit PCM, all zeros.
    private static func silentWAV(seconds: Int) -> Data {
        let rate: UInt32 = 16_000
        let dataSize = UInt32(seconds) * rate * 2
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36) + dataSize)
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        append(UInt32(16))
        append(UInt16(1))
        append(UInt16(1))
        append(rate)
        append(rate * 2)
        append(UInt16(2))
        append(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        append(dataSize)
        data.append(Data(count: Int(dataSize)))
        return data
    }

    // MARK: Transcription

    /// The scripted recording "transcribes" to the lines played, with their
    /// final speakers; any other file goes to the real engine.
    func transcribe(
        file: URL,
        mode: MeetingMode,
        modelId: String,
        language: String,
        knownSpeakers: [MeetingSpeaker],
        progress: @escaping @Sendable (Double) -> Void
    ) async throws -> MeetingTranscriptData {
        guard file == self.file else {
            return try await base.transcribe(file: file, mode: mode, modelId: modelId, language: language, knownSpeakers: knownSpeakers, progress: progress)
        }
        for step in 1...4 {
            try? await Task.sleep(nanoseconds: 60_000_000)
            progress(Double(step) / 4)
        }
        // everything said by then is known to be the late voice's
        if played > Self.correctedAtLine || lines[..<played].contains(where: { $0.voice == Self.lateVoice }) { corrected = true }
        let segments = (0..<played).map(segment)
        return MeetingTranscriptData(
            text: segments.map(\.text).joined(separator: " "),
            language: options.language,
            durationSeconds: 2 + Double(played) * 6,
            segments: segments,
            speakers: speakers(upTo: played)
        )
    }

    // MARK: A pretend speaker model (Settings can be looked at with it)

    var speakerModel: MeetingModelChoice? {
        MeetingModelChoice(id: "scripted-speakers", name: "Speaker identification (scripted)", sizeBytes: 32_400_000)
    }

    var isSpeakerModelDownloaded: Bool { speakerModelOnDisk }
    var speakerModelSizeOnDisk: Int64 { speakerModelOnDisk ? 32_400_000 : 0 }

    func downloadSpeakerModel(progress: @escaping @Sendable (Double) -> Void) async throws {
        for step in 1...20 {
            try await Task.sleep(nanoseconds: 150_000_000)
            progress(Double(step) / 20)
        }
        speakerModelOnDisk = true
    }

    func deleteSpeakerModel() throws {
        speakerModelOnDisk = false
    }

    // MARK: The real engine's parts

    var isAvailable: Bool { base.isAvailable }
    var unavailableReason: String { base.unavailableReason }
    var models: [MeetingModelChoice] { base.models }
    // a scripted meeting needs no transcription model: nothing is downloaded for it
    func isDownloaded(_ modelId: String) -> Bool { forSettings ? base.isDownloaded(modelId) : true }
    func sizeOnDisk(_ modelId: String) -> Int64 { base.sizeOnDisk(modelId) }
    func download(_ modelId: String, progress: @escaping @Sendable (Double) -> Void) async throws {
        if forSettings {
            try await base.download(modelId, progress: progress)
        } else {
            progress(1)
        }
    }
    func delete(_ modelId: String) throws { try base.delete(modelId) }

    func enqueue(target: MeetingDestination, transcript: MeetingTranscriptData, meeting: MeetingDelivery, audio: URL?) async throws -> String {
        try await base.enqueue(target: target, transcript: transcript, meeting: meeting, audio: audio)
    }

    func flush() async { await base.flush() }
    func jobs() async -> [MeetingJobInfo] { await base.jobs() }
    func removeJobs(profileId: String) async { await base.removeJobs(profileId: profileId) }

    var onDelivered: ((MeetingJobInfo) -> Void)? {
        get { base.onDelivered }
        set { base.onDelivered = newValue }
    }
}
#endif
