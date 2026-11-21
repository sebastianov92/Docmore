#!/usr/bin/env python3
"""Scores who-spoke-when against the ground truth of a generated recording.

    score-speakers.py truth.json hypothesis.json [--side room|remote] [--until SECONDS] [--json]
    score-speakers.py truth.json transcript.json --by-segment [--side room|remote]
    score-speakers.py --updates updates.jsonl

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

With --by-segment the unit is the text instead of the audio: every segment
of a transcript counts for its length, and is right when its speaker is
the voice paired with the reference speaker who talks the most in it. (The
time between two segments is not counted as missed, which it is above.)

With --updates the file is the output of `meetingkit live-meeting --json`:
the updates are applied one after another and the report says how often a
sentence that already had a speaker was given another one, and how many
speaker ids were shown in all against how many are left at the end.
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


def pair(counts, speakers, voices):
    """The one-to-one pairing of speakers and voices with the most agreement."""
    best = (-1, {})
    slots = voices + [None] * max(0, len(speakers) - len(voices))
    if len(slots) <= 8:
        for choice in itertools.permutations(slots, len(speakers)):
            score = sum(counts[speaker].get(voice, 0) for speaker, voice in zip(speakers, choice) if voice is not None)
            if score > best[0]:
                best = (score, dict(zip(speakers, choice)))
        return best
    pairing, used = {}, set()
    pairs = sorted(((counts[s].get(v, 0), s, v) for s in speakers for v in voices), reverse=True)
    for score, speaker, voice in pairs:
        if speaker not in pairing and voice not in used:
            pairing[speaker] = voice
            used.add(voice)
    return (sum(counts[s].get(v, 0) for s, v in pairing.items()), pairing)


def by_segment(truth, data, side, as_json):
    reference = [turn for turn in truth["turns"] if not side or turn.get("side", side) == side]
    segments = data.get("segments") or data.get("transcript", {}).get("segments") or []
    segments = [segment for segment in segments if not side or segment.get("side") == side]
    speakers = sorted({turn["speaker"] for turn in reference})
    counts = {speaker: {} for speaker in speakers}
    total = 0.0
    for segment in segments:
        shared = {}
        for turn in reference:
            overlap = min(segment["end"], turn["end"]) - max(segment["start"], turn["start"])
            if overlap > 0:
                shared[turn["speaker"]] = shared.get(turn["speaker"], 0) + overlap
        if not shared:
            continue
        owner = max(shared, key=shared.get)
        length = max(0.01, segment["end"] - segment["start"])
        voice = segment.get("speaker")
        counts[owner][voice] = counts[owner].get(voice, 0) + length
        total += length
    voices = sorted({voice for row in counts.values() for voice in row if voice is not None})
    correct, pairing = pair(counts, speakers, voices)
    unlabelled = sum(row.get(None, 0) for row in counts.values())
    wrong = total - correct - unlabelled

    def percent(value):
        return round(100.0 * value / total, 1) if total else 0.0

    result = {
        "referenceSpeakers": len(speakers), "speakersFound": len(voices), "segments": len(segments),
        "rightSpeakerPercent": percent(correct), "wrongSpeakerPercent": percent(wrong), "noSpeakerPercent": percent(unlabelled),
        "pairing": {speaker: pairing.get(speaker) for speaker in speakers},
    }
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
        return
    print("speakers %d, speakers found %d, %d segments: right speaker %.1f%%, wrong speaker %.1f%%, no speaker %.1f%%" % (
        len(speakers), len(voices), len(segments), percent(correct), percent(wrong), percent(unlabelled)))
    for speaker in speakers:
        row = counts[speaker]
        cells = " ".join("%s %.0fs" % ("(none)" if voice is None else voice, seconds) for voice, seconds in sorted(row.items(), key=lambda item: -item[1]))
        print("  %-10s -> %-6s  %s" % (speaker, pairing.get(speaker), cells))


def updates(path, as_json):
    current = []
    owners = {}
    ever = set()
    changes = 0
    count = 0
    with open(path, encoding="utf-8") as reader:
        for line in reader:
            line = line.strip()
            if not line.startswith("{"):
                continue
            update = json.loads(line).get("update")
            if not update:
                continue
            count += 1
            current = current[:update["fromIndex"]] + update["segments"]
            ever.update(speaker["id"] for speaker in update["speakers"])
            for segment in current:
                speaker = segment.get("speaker")
                if speaker is None:
                    continue
                key = (segment.get("side"), round(segment["start"], 1))
                if key in owners and owners[key] != speaker:
                    changes += 1
                owners[key] = speaker
    final = sorted({segment["speaker"] for segment in current if segment.get("speaker")})
    result = {"updates": count, "segments": len(current), "speakerChanges": changes,
              "speakersEverShown": len(ever), "speakersAtTheEnd": len(final)}
    if as_json:
        print(json.dumps(result))
    else:
        print("%d updates, %d segments at the end; a sentence changed speaker %d times; %d speaker ids shown in all, %d at the end" % (
            count, len(current), changes, len(ever), len(final)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("truth", nargs="?")
    parser.add_argument("hypothesis", nargs="?")
    parser.add_argument("--by-segment", action="store_true", help="score the segments of a transcript by their text")
    parser.add_argument("--updates", default=None, help="the JSON lines of `meetingkit live-meeting --json`")
    parser.add_argument("--side", choices=["room", "remote"], default=None, help="only the reference turns (and segments) of this side")
    parser.add_argument("--until", type=float, default=None, help="only the first SECONDS")
    parser.add_argument("--json", action="store_true")
    arguments = parser.parse_args()
    if arguments.updates:
        updates(arguments.updates, arguments.json)
        return
    if not arguments.truth or not arguments.hypothesis:
        parser.error("truth and hypothesis are needed")
    if arguments.by_segment:
        by_segment(load(arguments.truth), load(arguments.hypothesis), arguments.side, arguments.json)
        return

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

    best = pair(counts, speakers, voices)
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
