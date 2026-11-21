#!/usr/bin/env python3
"""Scores who-spoke-when against the ground truth of a generated recording.

    score-speakers.py truth.json hypothesis.json [--side room|remote] [--until SECONDS] [--json]

`truth.json` is what mac/tools/fixtures/meeting-es/make-fixture.py writes
(turns with speaker, start, end). `hypothesis.json` is the output of
`meetingkit diarize --json` (turns with cluster) or of `meetingkit process
--json` / `meetingkit live-meeting --json` (segments with speaker).

Every 10 ms of reference speech is counted. Hypothesis voices are paired
with reference speakers one to one so that the agreement is the largest
possible; then:

    correct   speech given to the voice paired with its speaker
    confused  speech given to another voice
    missed    speech with no voice at all
"""

import argparse
import itertools
import json
import sys

STEP = 0.01


def load(path):
    with open(path, encoding="utf-8") as reader:
        return json.load(reader)


def hypothesis_turns(data, side):
    if "turns" in data and data["turns"] and "cluster" in data["turns"][0]:
        return [(turn["start"], turn["end"], str(turn["cluster"])) for turn in data["turns"]]
    segments = data.get("segments") or data.get("transcript", {}).get("segments") or []
    turns = []
    for segment in segments:
        if side and segment.get("side") != side:
            continue
        turns.append((segment["start"], segment["end"], segment.get("speaker") or "(none)"))
    return turns


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("truth")
    parser.add_argument("hypothesis")
    parser.add_argument("--side", choices=["room", "remote"], default=None, help="only the reference turns (and segments) of this side")
    parser.add_argument("--until", type=float, default=None, help="only the first SECONDS")
    parser.add_argument("--json", action="store_true")
    arguments = parser.parse_args()

    truth = load(arguments.truth)
    reference = [turn for turn in truth["turns"] if not arguments.side or turn.get("side") == arguments.side]
    if arguments.until is not None:
        reference = [turn for turn in reference if turn["start"] < arguments.until]
    turns = hypothesis_turns(load(arguments.hypothesis), arguments.side)

    end = max([turn["end"] for turn in reference] + [0])
    if arguments.until is not None:
        end = min(end, arguments.until)
    frames = int(end / STEP) + 1
    voice_at = [None] * frames
    for start, stop, voice in turns:
        for frame in range(max(0, int(start / STEP)), min(frames, int(stop / STEP))):
            voice_at[frame] = voice

    speakers = sorted({turn["speaker"] for turn in reference})
    voices = sorted({voice for voice in voice_at if voice is not None and voice != "(none)"})
    counts = {speaker: {} for speaker in speakers}
    total = 0
    for turn in reference:
        row = counts[turn["speaker"]]
        for frame in range(int(turn["start"] / STEP), min(frames, int(turn["end"] / STEP))):
            voice = voice_at[frame]
            row[voice] = row.get(voice, 0) + 1
            total += 1

    # the one-to-one pairing with the most agreement
    best = (-1, {})
    slots = voices + [None] * max(0, len(speakers) - len(voices))
    if len(slots) <= 8:
        for choice in itertools.permutations(slots, len(speakers)):
            score = sum(counts[speaker].get(voice, 0) for speaker, voice in zip(speakers, choice) if voice is not None)
            if score > best[0]:
                best = (score, dict(zip(speakers, choice)))
    else:
        pairing, used = {}, set()
        pairs = sorted(((counts[s].get(v, 0), s, v) for s in speakers for v in voices), reverse=True)
        for score, speaker, voice in pairs:
            if speaker not in pairing and voice not in used:
                pairing[speaker] = voice
                used.add(voice)
        best = (sum(counts[s].get(v, 0) for s, v in pairing.items()), pairing)
    correct = best[0]
    missed = sum(row.get(None, 0) + row.get("(none)", 0) for row in counts.values())
    confused = total - correct - missed

    def percent(value):
        return round(100.0 * value / total, 1) if total else 0.0

    result = {
        "referenceSpeakers": len(speakers),
        "voicesFound": len(voices),
        "speechSeconds": round(total * STEP, 1),
        "correctPercent": percent(correct),
        "confusedPercent": percent(confused),
        "missedPercent": percent(missed),
        "pairing": {speaker: best[1].get(speaker) for speaker in speakers},
    }
    if arguments.json:
        print(json.dumps(result, ensure_ascii=False))
        return
    print("speakers %d, voices found %d, speech %.1f s: correct %.1f%%, confused %.1f%%, missed %.1f%%" % (
        len(speakers), len(voices), total * STEP, percent(correct), percent(confused), percent(missed)))
    header = ["(nothing)" if voice is None else voice for voice in voices + [None]]
    print("  %-10s %s" % ("", " ".join("%9s" % name for name in header)))
    for speaker in speakers:
        row = counts[speaker]
        cells = " ".join("%8.1fs" % (row.get(voice, 0) * STEP) for voice in voices + [None])
        print("  %-10s %s   -> %s" % (speaker, cells, best[1].get(speaker)))


if __name__ == "__main__":
    main()
