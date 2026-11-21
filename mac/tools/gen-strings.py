#!/usr/bin/env python3
"""Builds the String Catalogs of the Mac app.

Every user-facing string in the Swift sources is written as L("English text").
This script collects those keys, pairs each one with its Spanish text from
tools/strings.es.json and writes Docmore/Localizable.xcstrings. It fails when
a key has no translation, so a new string cannot ship in English only.

    tools/gen-strings.py           # write the catalogs
    tools/gen-strings.py --check   # only verify, exit 1 when something is missing
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAC = os.path.dirname(HERE)
SOURCES = os.path.join(MAC, "Docmore")
TABLE = os.path.join(HERE, "strings.es.json")
CATALOG = os.path.join(SOURCES, "Localizable.xcstrings")
INFO_CATALOG = os.path.join(SOURCES, "InfoPlist.xcstrings")

# L("...") with ordinary Swift escapes inside the literal
PATTERN = re.compile(r'\bL\(\s*"((?:[^"\\]|\\.)*)"')

# Info.plist strings macOS shows in its own permission prompts
INFO_STRINGS = {
    "NSMicrophoneUsageDescription": (
        "Docmore records your microphone when you record a meeting or attach a voice note.",
        "Docmore graba tu micr\u00f3fono cuando grabas una reuni\u00f3n o adjuntas una nota de voz.",
    ),
    "NSAudioCaptureUsageDescription": (
        "Docmore records the sound of the other participants (system audio) when you record a meeting.",
        "Docmore graba el sonido de los dem\u00e1s participantes (audio del sistema) cuando grabas una reuni\u00f3n.",
    ),
    "NSCameraUsageDescription": (
        "Docmore uses the camera only when a page asks to capture a photo or video.",
        "Docmore usa la c\u00e1mara solo cuando una p\u00e1gina pide capturar una foto o un video.",
    ),
    "NSLocalNetworkUsageDescription": (
        "Docmore connects to your Docmore server on the local network.",
        "Docmore se conecta a tu servidor Docmore en la red local.",
    ),
    "NSFaceIDUsageDescription": (
        "Docmore can ask for Touch ID to unlock the app.",
        "Docmore puede pedir Touch ID para desbloquear la app.",
    ),
}


def unescape(literal):
    return (
        literal.replace('\\"', '"')
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\\", "\\")
    )


def expand_unicode(text):
    # Swift "\u{00B7}" escapes inside literals
    return re.sub(r"\\u\{([0-9A-Fa-f]+)\}", lambda m: chr(int(m.group(1), 16)), text)


def collect_keys():
    keys = {}
    for base, _, files in os.walk(SOURCES):
        for name in sorted(files):
            if not name.endswith(".swift"):
                continue
            path = os.path.join(base, name)
            text = open(path, encoding="utf-8").read()
            for match in PATTERN.finditer(text):
                key = expand_unicode(unescape(match.group(1)))
                keys.setdefault(key, os.path.relpath(path, MAC))
    return keys


def specifiers(text):
    return re.findall(r"%(?:\d+\$)?(?:lld|ld|d|@|f)", text)


def main():
    check_only = "--check" in sys.argv
    keys = collect_keys()
    table = json.load(open(TABLE, encoding="utf-8")) if os.path.exists(TABLE) else {}

    missing = [key for key in keys if key not in table]
    unused = [key for key in table if key not in keys]
    mismatched = [
        key for key in keys
        if key in table and sorted(specifiers(key)) != sorted(specifiers(table[key]))
    ]
    if missing or mismatched:
        for key in missing:
            print("missing Spanish text: %r  (%s)" % (key, keys[key]))
        for key in mismatched:
            print("format arguments differ: %r -> %r" % (key, table[key]))
        return 1
    for key in unused:
        print("note: unused translation %r" % key)
    if check_only:
        print("%d strings, all translated" % len(keys))
        return 0

    strings = {}
    for key in sorted(keys):
        strings[key] = {
            "localizations": {
                "en": {"stringUnit": {"state": "translated", "value": key}},
                "es": {"stringUnit": {"state": "translated", "value": table[key]}},
            }
        }
    write_catalog(CATALOG, strings)

    info = {}
    for key, (english, spanish) in sorted(INFO_STRINGS.items()):
        info[key] = {
            "extractionState": "manual",
            "localizations": {
                "en": {"stringUnit": {"state": "translated", "value": english}},
                "es": {"stringUnit": {"state": "translated", "value": spanish}},
            },
        }
    write_catalog(INFO_CATALOG, info)
    print("%d strings written to %s" % (len(keys), os.path.relpath(CATALOG, MAC)))
    return 0


def write_catalog(path, strings):
    catalog = {"sourceLanguage": "en", "strings": strings, "version": "1.0"}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(catalog, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    sys.exit(main())
