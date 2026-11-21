#!/usr/bin/env python3
"""Builds the Spanish test meeting for MeetingKit, the server and the app.

A scripted meeting of a little over two minutes with four voices made by
the macOS `say` command: two people in the room (the microphone track) and
two on the other side of a call (the system audio track). A delivery date is
decided ("entregamos el viernes"), later changed ("mejor el lunes"), and a
task is given to someone by name.

    make-fixture.py                      # the meeting, into ./out next to this script
    make-fixture.py --out DIR
    make-fixture.py --long 60 --out DIR  # 60 minutes of turn-taking for benchmarks

Only the Python standard library, `say` and `afconvert` (both part of macOS).
The voices must be installed: System Settings > Accessibility > Spoken
Content > System Voice > Manage Voices (Spanish: Mónica, Paulina, Eddy
(Spain), Rocko (Mexico); the long recordings also use Flo, Grandpa, Reed and
Shelley).

What it writes for the meeting (16 kHz, 16-bit):

    meeting-es.json               who says what and when (the ground truth)
    meeting-es.room.wav           mono: the microphone track (Ana and Luis)
    meeting-es.remote.wav         mono: the system audio track (Marta and Carlos)
    meeting-es.virtual.wav        two channels: 0 = room, 1 = remote (what the recorder writes in virtual mode)
    meeting-es.mixed.wav          mono: everybody in one track (an in-person recording, or an old mixed one)
    meeting-es.room-echo.wav      mono: the microphone track when the call plays on loudspeakers
                                  (room + the remote track delayed 180 ms at 0.35 of its level)
    meeting-es.virtual-echo.wav   two channels: 0 = room with echo, 1 = remote

`say` does not promise the same samples on every macOS version: times in
the JSON are measured from what was really generated.
"""

import argparse
import array
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
import wave

RATE = 16000

# name -> (voice for `say`, side)
CAST = {
    "Ana": ("Mónica", "room"),
    "Luis": ("Eddy (Spanish (Spain))", "room"),
    "Marta": ("Paulina", "remote"),
    "Carlos": ("Rocko (Spanish (Mexico))", "remote"),
}
# The four voices were picked to be far apart for the speaker models. Not
# every pair of `say` voices is: "Eddy" and "Reed" are one and the same voice
# to them (voice print distance 0.02), and so nearly are "Flo" and "Shelley".

# (speaker, text, seconds of silence after it)
SCRIPT = [
    ("Ana", "Buenos días a todos. Empezamos la reunión de seguimiento del portal de clientes.", 0.7),
    ("Marta", "Buenos días. Por nuestra parte ya terminamos las pruebas de la pantalla de pagos y no encontramos errores graves.", 0.6),
    ("Luis", "Perfecto. Entonces solo falta revisar el informe de rendimiento antes de la entrega.", 0.8),
    ("Carlos", "El informe está casi listo. Me faltan los datos de la última semana.", 0.6),
    ("Ana", "¿Cuándo crees que puedes tenerlos?", 0.5),
    ("Carlos", "Mañana por la tarde. El equipo de infraestructura me los envía hoy.", 0.7),
    ("Luis", "Bien, así puedo revisar el informe el miércoles por la mañana.", 0.8),
    ("Ana", "De acuerdo. Entonces queda decidido: entregamos el viernes.", 0.7),
    ("Marta", "Me parece bien. El viernes por la mañana enviamos todo al cliente.", 0.9),
    ("Luis", "Otra cosa. Carlos, ¿puedes preparar la presentación para el cliente?", 0.6),
    ("Carlos", "Sí, yo preparo la presentación y la comparto el miércoles.", 0.7),
    ("Ana", "Hablemos del presupuesto. Marta, ¿cómo vamos con las horas del proyecto?", 0.6),
    ("Marta", "Hemos usado el ochenta por ciento de las horas. Nos quedan unas cuarenta para cerrar.", 0.7),
    ("Luis", "Con cuarenta horas alcanza, si no aparecen cambios nuevos.", 0.6),
    ("Carlos", "Si hace falta, puedo dedicar unas horas de mi equipo la próxima semana.", 0.8),
    ("Ana", "Bien. Marta, ¿hay algún riesgo que debamos tener en cuenta?", 0.6),
    ("Marta", "Sí, hay uno. El servidor de pruebas estará en mantenimiento el jueves, así que no podremos hacer la última verificación.", 0.8),
    ("Luis", "Eso es un problema. Sin esa verificación no me siento cómodo entregando el viernes.", 0.6),
    ("Carlos", "Estoy de acuerdo con Luis. Sería mejor tener un día más.", 0.7),
    ("Marta", "Podemos hacer la verificación el viernes, cuando el servidor vuelva a estar disponible.", 0.7),
    ("Ana", "Tienen razón. Cambiamos la decisión: mejor el lunes. Entregamos el lunes y no el viernes.", 0.8),
    ("Marta", "De acuerdo, el lunes. Yo aviso al cliente del cambio de fecha.", 0.6),
    ("Luis", "Y yo actualizo el calendario del proyecto hoy mismo.", 0.7),
    ("Ana", "Muy bien. Resumiendo: entregamos el lunes, Carlos prepara la presentación y Marta avisa al cliente. Gracias a todos.", 0.6),
    ("Carlos", "Gracias. Hasta luego.", 1.0),
]

LEAD_IN = 1.0
ECHO_DELAY = 0.18
ECHO_GAIN = 0.35

# Sentences for the long benchmark recordings (any voice says any of them).
POOL = [
    "Creo que deberíamos revisar el presupuesto antes de tomar una decisión definitiva.",
    "La semana pasada hablamos con el proveedor y nos confirmó los nuevos plazos.",
    "No estoy seguro de que tengamos suficiente gente para terminar a tiempo.",
    "Podemos dividir el trabajo en dos fases y entregar primero lo más urgente.",
    "El cliente pidió un cambio en el diseño de la página principal.",
    "Necesitamos más datos antes de saber si la campaña funcionó.",
    "Yo me encargo de escribir el resumen y enviarlo a todo el equipo.",
    "Me preocupa el rendimiento de la aplicación cuando hay muchos usuarios conectados.",
    "Propongo que hagamos una prueba pequeña con cinco clientes antes del lanzamiento.",
    "El informe de ventas muestra un crecimiento del doce por ciento este trimestre.",
    "Todavía falta resolver el problema con las facturas duplicadas.",
    "Si contratamos a otra persona en soporte, podríamos responder en menos de un día.",
    "La reunión con el banco es el martes a las diez de la mañana.",
    "Ya actualicé la documentación y agregué los ejemplos que faltaban.",
    "No me parece buena idea cambiar de herramienta en medio del proyecto.",
    "Tenemos que decidir quién va a presentar los resultados en la conferencia.",
    "El equipo de diseño terminó los prototipos y espera nuestros comentarios.",
    "Hay tres errores críticos abiertos y dos de ellos afectan a los pagos.",
    "Podríamos ahorrar bastante si renegociamos el contrato del servidor.",
    "Me gustaría escuchar la opinión de todos antes de continuar.",
    "El nuevo formulario redujo el tiempo de registro a menos de un minuto.",
    "Quedamos en revisar los avances cada lunes por la tarde.",
    "La auditoría de seguridad empieza el próximo mes y hay que preparar los accesos.",
    "Es mejor esperar a tener la aprobación legal antes de publicar el anuncio.",
    "Los usuarios se quejan de que la búsqueda no encuentra los documentos antiguos.",
    "Voy a pedir una cotización a dos empresas más para poder comparar.",
    "El plan de capacitación incluye cuatro sesiones de dos horas cada una.",
    "Con el cambio de horario, la llamada con Madrid será una hora más temprano.",
    "Hay que avisar a los clientes con una semana de anticipación.",
    "El almacén de Guadalajara ya recibió la mitad del pedido.",
    "Sugiero que dejemos ese tema para la próxima reunión porque hoy no alcanza el tiempo.",
    "La encuesta de satisfacción subió de siete a ocho puntos.",
    "Necesito que alguien me ayude a revisar los contratos antes del viernes.",
    "El costo de envío aumentó y eso afecta el margen de los productos pequeños.",
    "Estamos esperando la respuesta de recursos humanos sobre las nuevas vacantes.",
    "La migración de la base de datos se hará el sábado por la noche.",
    "Si todo sale bien, la versión nueva estará disponible a fin de mes.",
    "Me parece razonable, pero quiero ver los números antes de aprobarlo.",
    "El socio de Colombia quiere ampliar el acuerdo a dos países más.",
    "Entonces quedamos así y volvemos a hablar el jueves.",
]


def run(arguments, timeout=None):
    subprocess.run(arguments, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout)


def say(voice, text, path):
    """`say` now and then hangs on a sentence: give it 30 seconds, three times."""
    for attempt in range(3):
        try:
            run(["say", "-v", voice, "-o", path, text], timeout=30)
            return
        except subprocess.TimeoutExpired:
            continue
        except subprocess.CalledProcessError as error:
            sys.exit("say failed for the voice \"%s\": %s\nInstall it in System Settings > Accessibility > Spoken Content."
                     % (voice, error.stderr.decode("utf-8", "replace").strip()))
    sys.exit("say did not finish \"%s\" with the voice \"%s\"" % (text, voice))


def synthesize(voice, text, cache):
    """Speaks `text` with `voice`; returns 16 kHz mono int16 samples without the silence around them."""
    key = hashlib.sha1((voice + "\n" + text).encode("utf-8")).hexdigest()[:20]
    path = os.path.join(cache, key + ".wav")
    if not os.path.exists(path):
        aiff = os.path.join(cache, key + ".aiff")
        say(voice, text, aiff)
        partial = os.path.join(cache, key + ".partial.wav")
        run(["afconvert", "-f", "WAVE", "-d", "LEI16@%d" % RATE, "-c", "1", aiff, partial])
        os.replace(partial, path)
        os.remove(aiff)
    with wave.open(path, "rb") as reader:
        if reader.getframerate() != RATE or reader.getnchannels() != 1 or reader.getsampwidth() != 2:
            sys.exit("unexpected format in " + path)
        samples = array.array("h")
        samples.frombytes(reader.readframes(reader.getnframes()))
    if sys.byteorder == "big":
        samples.byteswap()
    # trim the silence `say` leaves at both ends, keeping 20 ms
    threshold = 200
    first = next((index for index, value in enumerate(samples) if abs(value) > threshold), 0)
    last = next((index for index in range(len(samples) - 1, -1, -1) if abs(samples[index]) > threshold), len(samples) - 1)
    margin = RATE // 50
    return samples[max(0, first - margin):min(len(samples), last + margin)]


def write_wav(path, channels):
    """Writes int16 channels of equal length as one WAV."""
    length = len(channels[0])
    if len(channels) == 1:
        frames = channels[0]
    else:
        frames = array.array("h", bytes(2 * length * len(channels)))
        for index, channel in enumerate(channels):
            frames[index::len(channels)] = channel
    if sys.byteorder == "big":
        frames = array.array("h", frames)
        frames.byteswap()
    with wave.open(path, "wb") as writer:
        writer.setnchannels(len(channels))
        writer.setsampwidth(2)
        writer.setframerate(RATE)
        writer.writeframes(frames.tobytes())


def clamp(value):
    return max(-32768, min(32767, int(round(value))))


def mix(first, second, gain=1.0, delay=0):
    """first + gain * second delayed by `delay` samples, same length as `first`."""
    out = array.array("h", first)
    for index in range(delay, len(out)):
        value = second[index - delay]
        if value:
            out[index] = clamp(out[index] + gain * value)
    return out


def place(track, samples, start):
    track[start:start + len(samples)] = samples


def seconds(samples):
    return round(samples / RATE, 3)


def build_meeting(out, cache):
    spoken = []
    cursor = int(LEAD_IN * RATE)
    for speaker, text, pause in SCRIPT:
        voice, side = CAST[speaker]
        samples = synthesize(voice, text, cache)
        spoken.append((speaker, side, voice, text, cursor, samples))
        cursor += len(samples) + int(pause * RATE)
    total = cursor
    room = array.array("h", bytes(2 * total))
    remote = array.array("h", bytes(2 * total))
    for speaker, side, voice, text, start, samples in spoken:
        place(room if side == "room" else remote, samples, start)
    mixed = mix(room, remote)
    room_echo = mix(room, remote, gain=ECHO_GAIN, delay=int(ECHO_DELAY * RATE))

    def target(name):
        return os.path.join(out, "meeting-es." + name)

    write_wav(target("room.wav"), [room])
    write_wav(target("remote.wav"), [remote])
    write_wav(target("virtual.wav"), [room, remote])
    write_wav(target("mixed.wav"), [mixed])
    write_wav(target("room-echo.wav"), [room_echo])
    write_wav(target("virtual-echo.wav"), [room_echo, remote])
    truth = {
        "language": "es",
        "durationSeconds": seconds(total),
        "sampleRate": RATE,
        "echo": {"delaySeconds": ECHO_DELAY, "gain": ECHO_GAIN},
        "cast": [{"name": name, "voice": voice, "side": side} for name, (voice, side) in CAST.items()],
        "turns": [
            {"speaker": speaker, "side": side, "start": seconds(start), "end": seconds(start + len(samples)), "text": text}
            for speaker, side, voice, text, start, samples in spoken
        ],
    }
    with open(target("json"), "w", encoding="utf-8") as writer:
        json.dump(truth, writer, ensure_ascii=False, indent=2)
        writer.write("\n")
    print("%s: %.1f s, %d turns" % (out, total / RATE, len(spoken)))


LONG_VOICES = [
    ("Ana", "Mónica"),
    ("Luis", "Eddy (Spanish (Spain))"),
    ("Marta", "Paulina"),
    ("Carlos", "Rocko (Spanish (Mexico))"),
    ("Elena", "Flo (Spanish (Spain))"),
    ("Pedro", "Grandpa (Spanish (Mexico))"),
    # for measurements only: voices the speaker models can hardly tell from another one above
    ("Reed", "Reed (Spanish (Mexico))"),
    ("Shelley", "Shelley (Spanish (Spain))"),
]


def build_long(out, cache, minutes, voices, seed, name):
    """Turn-taking between `voices` for `minutes`, one mono track.

    With three voices or more, the last one only speaks in the first tenth
    and in the last sixth of the recording: a voice that comes back after a
    long silence.
    """
    generator = random.Random(seed)
    total = int(minutes * 60 * RATE)
    track = array.array("h", bytes(2 * total))
    turns = []
    cursor = RATE
    previous = None
    while True:
        position = cursor / total
        candidates = list(voices)
        if len(voices) > 2 and 0.10 <= position < 0.84:
            candidates = voices[:-1]
        choices = [voice for voice in candidates if voice != previous] or candidates
        speaker, voice = generator.choice(choices)
        previous = (speaker, voice)
        start = cursor
        texts = []
        for _ in range(generator.randint(1, 3)):
            text = generator.choice(POOL)
            samples = synthesize(voice, text, cache)
            if cursor + len(samples) >= total:
                break
            place(track, samples, cursor)
            texts.append(text)
            cursor += len(samples) + int(generator.uniform(0.15, 0.35) * RATE)
        if not texts:
            break
        turns.append({"speaker": speaker, "start": seconds(start), "end": seconds(cursor), "text": " ".join(texts)})
        cursor += int(generator.uniform(0.3, 1.2) * RATE)
    write_wav(os.path.join(out, name + ".wav"), [track])
    truth = {
        "language": "es",
        "durationSeconds": seconds(total),
        "cast": [{"name": speaker, "voice": voice} for speaker, voice in voices],
        "turns": turns,
    }
    with open(os.path.join(out, name + ".json"), "w", encoding="utf-8") as writer:
        json.dump(truth, writer, ensure_ascii=False, indent=2)
        writer.write("\n")
    print("%s/%s.wav: %.1f min, %d voices, %d turns" % (out, name, minutes, len(voices), len(turns)))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Builds the Spanish test meeting (see the top of this file).")
    parser.add_argument("--out", default=os.path.join(here, "out"), help="where to write (default: ./out next to this script)")
    parser.add_argument("--cache", default=None, help="keeps the spoken sentences between runs (default: a temporary folder)")
    parser.add_argument("--long", type=float, default=None, metavar="MINUTES", help="instead of the meeting: a long benchmark recording")
    parser.add_argument("--voices", type=int, default=4, help="voices in the long recording, 2 to 6 (default 4)")
    parser.add_argument("--cast", default=None, help="instead of --voices: names from %s, comma separated" % ", ".join(name for name, _ in LONG_VOICES))
    parser.add_argument("--seed", type=int, default=7, help="order of the turns in the long recording")
    parser.add_argument("--name", default=None, help="file name of the long recording, without extension")
    arguments = parser.parse_args()
    os.makedirs(arguments.out, exist_ok=True)

    def build(cache):
        if arguments.long is None:
            build_meeting(arguments.out, cache)
        else:
            if arguments.cast:
                wanted = [name.strip() for name in arguments.cast.split(",") if name.strip()]
                voices = [entry for name in wanted for entry in LONG_VOICES if entry[0] == name]
                if len(voices) != len(wanted) or len(voices) < 1:
                    sys.exit("--cast takes names from: " + ", ".join(name for name, _ in LONG_VOICES))
            else:
                voices = LONG_VOICES[:max(2, min(6, arguments.voices))]
            name = arguments.name or ("long-%gmin-%dvoices" % (arguments.long, len(voices)))
            build_long(arguments.out, cache, arguments.long, voices, arguments.seed, name)

    if arguments.cache:
        os.makedirs(arguments.cache, exist_ok=True)
        build(arguments.cache)
    else:
        with tempfile.TemporaryDirectory() as cache:
            build(cache)


if __name__ == "__main__":
    main()
