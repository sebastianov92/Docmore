#!/bin/bash
# End to end against a Docmore server: transcribe a recording on this Mac,
# queue it, send it, wait for the notes and read them back from the page.
#
# Usage: Tools/e2e.sh <audio file> [--server URL] [--model tiny] [--keep-pages]
#
# Steps
#   1. build, make sure the model is on disk (downloads it the first time)
#   2. one bearer token (Tools/lab-token.sh: one login per run, reused while valid)
#   3. a test page in the space "general"
#   4. meetingkit enqueue (transcribes; nothing is sent)
#   5. meetingkit flush against a server that is not there: the job stays
#   6. meetingkit flush against the real server: the job goes out
#   7. meetingkit flush again: nothing left, nothing sent twice; then the
#      same job put back (as if its answer had been lost) and flushed: the
#      server answers with the same meeting, not a second one
#   8. meetingkit status --wait until the notes are done
#   9. the page now contains the transcript (looks for --expect, default "homepage")
#  10. the same with a space as the target (the server creates the page)
#  11. the pages are deleted
#
# Prints PASS/FAIL per check and exits non-zero when one fails. Never prints
# credentials or tokens. Everything it writes is under .build/scratch.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/.." && pwd)"
SERVER="http://localhost:3100"
MODEL="tiny"
EXPECT="homepage"
KEEP=0
AUDIO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --expect) EXPECT="$2"; shift 2 ;;
    --keep-pages) KEEP=1; shift ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) AUDIO="$1"; shift ;;
  esac
done
SERVER="${SERVER%/}"
if [ -z "$AUDIO" ] || [ ! -f "$AUDIO" ]; then
  echo "usage: Tools/e2e.sh <audio file> [--server URL] [--model tiny] [--expect word] [--keep-pages]" >&2
  exit 2
fi

SCRATCH="$PACKAGE/.build/scratch"
MODELS="$SCRATCH/models"
RUN="$SCRATCH/e2e/$(date +%Y%m%d-%H%M%S)"
QUEUE="$RUN/queue"
mkdir -p "$RUN" "$MODELS"
BIN="$PACKAGE/.build/debug/meetingkit"
FAILED=0
PAGES=()

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', wanted '$2')"; fi; }

# POST <path> <json body> -> body in $RUN/api.out, prints the HTTP code.
# Retries while the lab restarts.
api() {
  local code="000" attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    code=$(curl -sS -m 30 -o "$RUN/api.out" -w '%{http_code}' -H @"$RUN/auth-header" \
      -H 'Content-Type: application/json' --data-binary "$2" "$SERVER$1" 2>/dev/null || true)
    case "$code" in 000|502|503|504) sleep 10 ;; *) break ;; esac
  done
  echo "$code"
}
field() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1])); d=d.get("data",d)
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$RUN/api.out" "$1"; }

cleanup() {
  if [ "$KEEP" = "0" ]; then
    for page in "${PAGES[@]:-}"; do
      [ -n "$page" ] || continue
      code=$(api /api/pages/delete "{\"pageId\":\"$page\"}")
      echo "deleted page $page (HTTP $code)"
    done
  fi
  rm -f "$RUN/auth-header"
}
trap cleanup EXIT

echo "== 1. build and model"
(cd "$PACKAGE" && swift build --build-path .build 2>&1 | tail -1)
if ! "$BIN" models --models-dir "$MODELS" | grep "$(${BIN} models | awk -v m="$MODEL" '$1==m || index($1,m){print $1; exit}')" | grep -q "\[downloaded"; then
  "$BIN" download "$MODEL" --models-dir "$MODELS" 2>/dev/null || { echo "model download failed" >&2; exit 1; }
fi

echo "== 2. token"
TOKEN_FILE="$("$HERE/lab-token.sh" --server "$SERVER")" || exit 1
( umask 077; python3 -c 'import json,sys
open(sys.argv[2],"w").write("Authorization: Bearer "+json.load(open(sys.argv[1]))["accessToken"])' "$TOKEN_FILE" "$RUN/auth-header" )

echo "== 3. a test page in the space 'general'"
code=$(api /api/spaces '{}')
check "$code" 200 "list spaces"
SPACE=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))["data"]["items"]
print(next(s["id"] for s in d if s["slug"]=="general"))' "$RUN/api.out")
code=$(api /api/pages/create "{\"spaceId\":\"$SPACE\",\"title\":\"MeetingKit e2e $(date +%H:%M:%S)\"}")
check "$code" 200 "create the test page"
PAGE=$(field id)
PAGES+=("$PAGE")
echo "page $PAGE in space $SPACE"

echo "== 4. enqueue (transcribe on this Mac)"
"$BIN" enqueue "$AUDIO" --queue-dir "$QUEUE" --page "$PAGE" --title "Weekly sync" --model "$MODEL" --models-dir "$MODELS" 2>/dev/null
check "$?" 0 "meetingkit enqueue"
check "$(ls "$QUEUE"/*.json 2>/dev/null | wc -l | tr -d ' ')" 1 "one job file in the queue"
JOB=$(basename "$(ls "$QUEUE"/*.json)" .json)
if grep -qi "$EXPECT" "$QUEUE/$JOB.json"; then pass "the queued transcript contains \"$EXPECT\""; else fail "the queued transcript contains \"$EXPECT\""; fi
python3 -c 'import json,sys;open(sys.argv[2],"w").write(json.load(open(sys.argv[1]))["transcript"]["text"])' "$QUEUE/$JOB.json" "$RUN/transcript.txt"
# what the server should report back: language, whole seconds, title
SENT_FACTS=$(python3 -c 'import json,sys,math
j=json.load(open(sys.argv[1])); t=j["transcript"]
print(t["language"], math.floor(t["durationSeconds"]+0.5), j["target"]["title"])' "$QUEUE/$JOB.json")
echo "   transcript: $(cut -c 1-120 "$RUN/transcript.txt")..."

echo "== 5. flush against a server that is not there"
"$BIN" flush --queue-dir "$QUEUE" --server http://127.0.0.1:9 --token-file "$TOKEN_FILE" --json > "$RUN/flush-unreachable.json"
check "$?" 3 "flush exits 3 (jobs still waiting)"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d["sent"]),d["pending"],len(d["failed"]),d["needsSignIn"])' "$RUN/flush-unreachable.json")" "0 1 0 False" "nothing sent, the job is kept, not failed"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["attempts"], d["lastError"] is not None)' "$QUEUE/$JOB.json")" "1 True" "the job file records the attempt and the reason"

echo "== 5b. flush with a token the server does not know"
( umask 077; printf 'not-a-real-token' > "$RUN/bad-token" )
"$BIN" flush --queue-dir "$QUEUE" --server "$SERVER" --token-file "$RUN/bad-token" --json > "$RUN/flush-401.json"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d["sent"]),d["pending"],len(d["failed"]),d["needsSignIn"])' "$RUN/flush-401.json")" "0 1 0 True" "401: the job is kept and the report says needs sign-in"
rm -f "$RUN/bad-token"

cp "$QUEUE/$JOB.json" "$RUN/job-copy.json"

echo "== 6. flush against the server"
"$BIN" flush --queue-dir "$QUEUE" --server "$SERVER" --token-file "$TOKEN_FILE" --json > "$RUN/flush-real.json"
check "$?" 0 "flush exits 0"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d["sent"]),d["pending"],len(d["failed"]))' "$RUN/flush-real.json")" "1 0 0" "the job was sent"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["sent"][0]["jobId"])' "$RUN/flush-real.json")" "$JOB" "it is the job that was kept before"
MEETING=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sent"][0]["meetingId"])' "$RUN/flush-real.json")
check "$(ls "$QUEUE"/*.json 2>/dev/null | wc -l | tr -d ' ')" 0 "the queue is empty"
echo "meeting $MEETING"

echo "== 7. flush again"
"$BIN" flush --queue-dir "$QUEUE" --server "$SERVER" --token-file "$TOKEN_FILE" --json > "$RUN/flush-again.json"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d["sent"]),d["pending"])' "$RUN/flush-again.json")" "0 0" "nothing is sent twice"

echo "== 7b. the answer was lost: the same job is sent again"
# what a timeout after the server took the transcript leaves behind: the job still in the queue
cp "$RUN/job-copy.json" "$QUEUE/$JOB.json"
"$BIN" flush --queue-dir "$QUEUE" --server "$SERVER" --token-file "$TOKEN_FILE" --json > "$RUN/flush-replay.json"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d["sent"]),d["pending"],len(d["failed"]))' "$RUN/flush-replay.json")" "1 0 0" "the repeat is accepted"
check "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sent"][0]["meetingId"])' "$RUN/flush-replay.json")" "$MEETING" "the server answers with the same meeting (Idempotency-Key)"
code=$(api /api/ai/meetings '{}')
check "$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1])); d=d.get("data",d)
print(sum(1 for m in d["items"] if m.get("pageId")==sys.argv[2]))' "$RUN/api.out" "$PAGE")" "1" "the server has one meeting for the test page, not two"

echo "== 8. wait for the notes"
STATUS=$("$BIN" status "$MEETING" --server "$SERVER" --token-file "$TOKEN_FILE" --wait 180)
echo "status: $STATUS"
case "$STATUS" in "done page $PAGE"*) pass "the meeting is done and points at the test page" ;; *) fail "the meeting is done and points at the test page" ;; esac
code=$(api /api/ai/meetings/status "{\"meetingId\":\"$MEETING\"}")
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]))["data"];print(d["status"], d["language"], d["durationSeconds"], d["fileName"])' "$RUN/api.out")" "done $SENT_FACTS" "the server has the language, the duration and the title ($SENT_FACTS)"

echo "== 9. the page has the transcript"
code=$(api /api/pages/info "{\"pageId\":\"$PAGE\"}")
check "$code" 200 "read the page"
python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))["data"]
def text(node):
    out=[]
    if isinstance(node,dict):
        if "text" in node: out.append(node["text"])
        for child in node.get("content",[]) or []: out.extend(text(child))
    return out
open(sys.argv[2],"w").write("\n".join(text(d.get("content") or {})))' "$RUN/api.out" "$RUN/page-text.txt"
if grep -qi "$EXPECT" "$RUN/page-text.txt"; then pass "the page text contains \"$EXPECT\""; else fail "the page text contains \"$EXPECT\""; fi
# not only the summary the model wrote: the transcript itself, word for word
if python3 -c 'import sys
norm=lambda t: " ".join(t.split())
sys.exit(0 if norm(open(sys.argv[1]).read()) in norm(open(sys.argv[2]).read()) else 1)' "$RUN/transcript.txt" "$RUN/page-text.txt"; then
  pass "the page has the whole transcript, word for word"
else
  fail "the page has the whole transcript, word for word"
fi
check "$(grep -c '^Transcript$' "$RUN/page-text.txt")" "1" "the notes were written once"
echo "   $(wc -c < "$RUN/page-text.txt" | tr -d ' ') characters on the page; the line with \"$EXPECT\":"
grep -i -m 2 "$EXPECT" "$RUN/page-text.txt" | cut -c 1-200 | sed 's/^/   | /'

echo "== 10. a space as the target (the server creates the page)"
"$BIN" enqueue "$AUDIO" --queue-dir "$QUEUE" --space "$SPACE" --title "MeetingKit e2e space target" --model "$MODEL" --models-dir "$MODELS" >/dev/null 2>&1
"$BIN" flush --queue-dir "$QUEUE" --server "$SERVER" --token-file "$TOKEN_FILE" --json > "$RUN/flush-space.json"
check "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d["sent"]),d["pending"],len(d["failed"]))' "$RUN/flush-space.json")" "1 0 0" "the job was sent"
MEETING2=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sent"][0]["meetingId"])' "$RUN/flush-space.json")
STATUS2=$("$BIN" status "$MEETING2" --server "$SERVER" --token-file "$TOKEN_FILE" --wait 180)
echo "status: $STATUS2"
PAGE2=$(echo "$STATUS2" | awk '$1=="done" && $2=="page"{print $3}')
if [ -n "$PAGE2" ] && [ "$PAGE2" != "$PAGE" ]; then
  pass "the meeting is done and has a new page"
  PAGES+=("$PAGE2")
  code=$(api /api/pages/info "{\"pageId\":\"$PAGE2\"}")
  if grep -qi "$EXPECT" "$RUN/api.out"; then pass "the new page contains \"$EXPECT\""; else fail "the new page contains \"$EXPECT\""; fi
else
  fail "the meeting is done and has a new page"
fi

echo "== 11. clean up"
[ "$FAILED" = "0" ] && echo "ALL PASSED" || echo "SOME CHECKS FAILED"
exit "$FAILED"
