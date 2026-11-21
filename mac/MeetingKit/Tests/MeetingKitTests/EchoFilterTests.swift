import XCTest
@testable import MeetingKit

final class EchoFilterTests: XCTestCase {
    func testARoomSegmentThatRepeatsTheRemoteSideIsDropped() {
        let room = [
            labelled("Buenos días a todos", 0, 3, speaker: "s1", side: .room),
            labelled("Por nuestra parte ya terminamos las pruebas", 5.2, 9.2, speaker: "s9", side: .room),
            labelled("Perfecto, entonces falta el informe", 10, 13, speaker: "s2", side: .room),
        ]
        let remote = [labelled("Por nuestra parte ya terminamos las pruebas.", 5, 9, speaker: "s3", side: .remote)]
        let result = EchoFilter.removeEcho(room: room, remote: remote)
        XCTAssertEqual(result.dropped.map(\.text), ["Por nuestra parte ya terminamos las pruebas"])
        XCTAssertEqual(result.kept.map(\.text), ["Buenos días a todos", "Perfecto, entonces falta el informe"])
        XCTAssertEqual(result.kept.map(\.speaker), ["s1", "s2"])
    }

    func testWhatOnlyTheRoomSaidIsNeverDropped() {
        let remote = [
            labelled("El informe de ventas de la semana está listo", 30, 34, side: .remote),
            labelled("Me parece bien, el viernes por la mañana", 40, 43, side: .remote),
        ]
        let room = [
            // nothing like it on the other side
            labelled("Yo actualizo el calendario del proyecto hoy mismo", 20, 24, speaker: "s1"),
            // the very same words, a minute later: said again, not an echo
            labelled("Me parece bien, el viernes por la mañana", 100, 103, speaker: "s1"),
            // talking over the remote side with some of the same small words
            labelled("No, de la otra semana", 30.5, 32, speaker: "s2"),
            // while the remote side talks, about something else
            labelled("Espera, tengo otra llamada entrando ahora", 40.2, 43.2, speaker: "s2"),
        ]
        let result = EchoFilter.removeEcho(room: room, remote: remote)
        XCTAssertEqual(result.dropped, [])
        XCTAssertEqual(result.kept, room)
        XCTAssertEqual(EchoFilter.removeEcho(room: room, remote: []).kept, room, "no remote side, nothing to compare")
        XCTAssertEqual(EchoFilter.removeEcho(room: [], remote: remote).kept, [])
    }

    func testTheQuieterCopyMayBeHeardSlightlyDifferently() {
        let remote = [labelled("Hemos usado el ochenta por ciento de las horas del proyecto", 56, 61, side: .remote)]
        // a letter lost, a word wrong, another split of the sentence
        let room = [
            labelled("Hemos usado el ochenta por ciento", 56.3, 59, speaker: "s9"),
            labelled("de la hora del proyector", 59, 61.2, speaker: "s9"),
        ]
        let result = EchoFilter.removeEcho(room: room, remote: remote)
        XCTAssertEqual(result.kept, [])
        XCTAssertEqual(result.dropped.count, 2)
    }

    func testShortAnswersNeedToBeRightOnTime() {
        let remote = [labelled("Sí.", 20.0, 20.4, side: .remote), labelled("Gracias. Hasta luego.", 50, 51.5, side: .remote)]
        let room = [
            labelled("Sí.", 20.2, 20.6, speaker: "s9"),            // its echo
            labelled("Sí.", 23.0, 23.4, speaker: "s1"),            // somebody in the room agreeing three seconds later
            labelled("Gracias.", 50.2, 50.8, speaker: "s9"),       // echo of the first word of a longer sentence
            labelled("Gracias.", 53.5, 54.0, speaker: "s1"),       // the room answering
        ]
        let result = EchoFilter.removeEcho(room: room, remote: remote)
        XCTAssertEqual(result.dropped.map(\.start), [20.2, 50.2])
        XCTAssertEqual(result.kept.map(\.start), [23.0, 53.5])
    }

    func testAVoiceThatIsMostlyEchoNeedsLessEvidence() {
        let remote = [
            labelled("Por nuestra parte ya terminamos las pruebas de pagos", 5, 9, side: .remote),
            labelled("El servidor estará en mantenimiento el jueves", 20, 24, side: .remote),
            labelled("Sería mejor tener un día más", 30, 33, side: .remote),
        ]
        // Whisper heard the third sentence badly on the microphone
        let garbled = "Sería mejor entender un cinema"
        func room(garbledSpeaker: String) -> [LabelledSegment] {
            [
                labelled("Por nuestra parte ya terminamos las pruebas de pagos", 5.2, 9.2, speaker: "s9"),
                labelled("El servidor estará en mantenimiento el jueves", 20.2, 24.2, speaker: "s9"),
                labelled(garbled, 30.2, 33.2, speaker: garbledSpeaker),
                labelled("Yo reviso el manual mientras tanto y lo envío mañana", 40, 44, speaker: "s1"),
            ]
        }
        // from the voice of the loudspeaker: dropped
        let fromEchoVoice = EchoFilter.removeEcho(room: room(garbledSpeaker: "s9"), remote: remote)
        XCTAssertEqual(fromEchoVoice.kept.map(\.speaker), ["s1"])
        XCTAssertEqual(fromEchoVoice.dropped.count, 3)
        // from a voice of the room: half of the words are not what the remote side said, so it stays
        let fromRoomVoice = EchoFilter.removeEcho(room: room(garbledSpeaker: "s1"), remote: remote)
        XCTAssertEqual(fromRoomVoice.kept.map(\.text), [garbled, "Yo reviso el manual mientras tanto y lo envío mañana"])
    }

    func testItWorksWithoutWordTimes() {
        let remote = [labelled("Podemos hacer la verificación el viernes cuando el servidor vuelva", 93, 98, side: .remote, wordTimes: false)]
        let room = [
            labelled("Podemos hacer la verificación el viernes cuando el servidor vuelva", 93.4, 98.6, speaker: "s9", wordTimes: false),
            labelled("Tienen razón, cambiamos la decisión, mejor el lunes", 99, 104, speaker: "s1", wordTimes: false),
        ]
        let result = EchoFilter.removeEcho(room: room, remote: remote)
        XCTAssertEqual(result.kept.map(\.speaker), ["s1"])
    }

    func testTheSameInputGivesTheSameAnswer() {
        let remote = [labelled("Estoy de acuerdo con Luis, sería mejor tener un día más", 89, 92.6, side: .remote)]
        let room = [
            labelled("Eso es un problema", 84, 86, speaker: "s2"),
            labelled("Estoy de acuerdo con Luis, sería mejor tener un día más", 89.2, 92.8, speaker: "s7"),
        ]
        let first = EchoFilter.removeEcho(room: room, remote: remote)
        for _ in 0..<5 {
            XCTAssertEqual(EchoFilter.removeEcho(room: room, remote: remote), first)
        }
        XCTAssertEqual(first.kept.map(\.speaker), ["s2"])
    }

    func testWords() {
        XCTAssertEqual(EchoFilter.normalize("¿Cuándo, EL-80% de Ñandú?"), ["cuando", "el", "80", "de", "nandu"])
        XCTAssertEqual(EchoFilter.normalize("  ...  "), [])
        XCTAssertTrue(EchoFilter.sameWord("pruebas", "pruebas"))
        XCTAssertTrue(EchoFilter.sameWord("pruebas", "prueba"), "a letter off in a long word")
        XCTAssertTrue(EchoFilter.sameWord("mantenimiento", "mantenimento"))
        XCTAssertFalse(EchoFilter.sameWord("lunes", "martes"))
        XCTAssertFalse(EchoFilter.sameWord("el", "al"), "short words have to be equal")
        XCTAssertFalse(EchoFilter.sameWord("casa", "cosa"))
        XCTAssertEqual(EchoFilter.editDistance("viernes", "vienes"), 1)
        XCTAssertEqual(EchoFilter.editDistance("", "abc"), 3)
        // words with times keep them; without, they are spread over the segment
        let withTimes = EchoFilter.tokens(of: labelled("hola a todos", 10, 13))
        XCTAssertEqual(withTimes.map(\.text), ["hola", "a", "todos"])
        XCTAssertEqual(withTimes.map(\.time), [10, 11, 12])
        XCTAssertTrue(withTimes.allSatisfy(\.timed))
        let spread = EchoFilter.tokens(of: labelled("hola a todos", 10, 13, wordTimes: false))
        XCTAssertEqual(spread.map(\.time), [10.5, 11.5, 12.5])
        XCTAssertFalse(spread.contains(where: \.timed))
    }
}
