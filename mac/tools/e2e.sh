#!/bin/bash
# End-to-end check of the Docmore Mac shell (stage A) against a running
# server, driven through the automation server of a DEBUG build.
#
#   tools/e2e.sh                      # against http://localhost:3100
#   DOCMORE_E2E_SERVER=http://host:port tools/e2e.sh
#   DOCMORE_E2E_KEEP=1 tools/e2e.sh   # keep the data directory afterwards
#
# The app runs with DOCMORE_DATA_DIR in a fresh temporary directory, so no
# real account, Keychain item, notification or Spotlight entry is touched.
# Uses only the test accounts of the repository's .env and deletes the pages
# it creates. Screenshots and logs land in mac/build/e2e/<time>/.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$(cd "$HERE/.." && pwd)"
APP="${DOCMORE_E2E_APP:-$MAC/build/Build/Products/Debug/Docmore.app/Contents/MacOS/Docmore}"
SERVER="${DOCMORE_E2E_SERVER:-http://localhost:3100}"
SERVER="${SERVER%/}"
PORT="${DOCMORE_E2E_PORT:-$((47200 + RANDOM % 700))}"
TOKEN="$(openssl rand -hex 16)"
STAMP="$(date +%Y%m%d-%H%M%S)"
ART="$MAC/build/e2e/$STAMP"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/docmore-e2e.XXXXXX")"
DATA="$(cd "$DATA" && pwd -P)"
# the app reports its data directory in Foundation's standard spelling
DATA_STD="${DATA#/private}"
BASE="http://127.0.0.1:$PORT"
APP_PID=""
PASS=0
FAIL=0
SKIP=0
FAILED_NAMES=()
WEBDATA_DIRS=()
DEFAULTS_SUITE=""
CREATED_PAGES=()
TOKEN_FILE="$DATA-token.json"

mkdir -p "$ART/downloads"

# Meetings: a speech sample (16 kHz mono WAV that mentions a homepage) and a
# place to keep the small transcription model between runs.
MEETING_WAV="${DOCMORE_E2E_MEETING_WAV:-$MAC/tools/fixtures/meeting.wav}"
MODEL_CACHE="$MAC/build/e2e-models"
if [ -d "$MODEL_CACHE" ]; then
  mkdir -p "$DATA/models"
  cp -Rc "$MODEL_CACHE/." "$DATA/models/" 2>/dev/null || cp -R "$MODEL_CACHE/." "$DATA/models/"
fi

if [ ! -x "$APP" ]; then
  echo "app not built: $APP" >&2
  echo "build it first: xcodebuild -project mac/Docmore.xcodeproj -scheme Docmore -configuration Debug -derivedDataPath mac/build build" >&2
  exit 2
fi

# Installs window.__e2eCall(type, payload): a bridge call from a test script
# that waits for the native answer, next to the page's own bridge client.
E2E_HELPERS='if (!window.__e2eCall) { const original = window.__docmoreNativeReply; const waiting = new Map(); window.__docmoreNativeReply = (id, error, result) => { const entry = waiting.get(id); if (!entry) return original && original(id, error, result); waiting.delete(id); error ? entry.reject(new Error(error)) : entry.resolve(result); }; let n = 0; window.__e2eCall = (type, payload) => new Promise((resolve, reject) => { const id = "e2e-" + (++n); waiting.set(id, { resolve, reject }); window.webkit.messageHandlers.docmore.postMessage({ id, type, payload: payload || null }); setTimeout(() => reject(new Error("no answer to " + type)), 60000); }); }'

say() { printf '%s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "${2:0:900}"; return 0; }
skip() { SKIP=$((SKIP + 1)); printf '  skip  %s (%s)\n' "$1" "$2"; }

auto_get() { curl -s -m 120 -H "X-Automation-Token: $TOKEN" "$BASE$1" ${2:+-o "$2"}; }
auto_post() { curl -s -m 400 -H "X-Automation-Token: $TOKEN" -H 'Content-Type: application/json' --data-binary "${2:-{\}}" "$BASE$1"; }

# ev [timeout] <<'JS' ... JS : runs the body of an async function in the page
EV_WINDOW=""   # set to a window index to run a script in another window
ev() {
  local timeout="${1:-30}"
  python3 -c 'import json,sys
body = {"js": sys.stdin.read(), "timeout": float(sys.argv[1])}
if sys.argv[2] != "": body["window"] = int(sys.argv[2])
print(json.dumps(body))' "$timeout" "$EV_WINDOW" \
    | curl -s -m 400 -H "X-Automation-Token: $TOKEN" -H 'Content-Type: application/json' --data-binary @- "$BASE/automation/eval"
}

# jq_py JSON 'expression over d' : prints the value
jq_py() { python3 -c 'import json,sys
d=json.loads(sys.argv[1])
v=eval(sys.argv[2])
print(v if not isinstance(v,(dict,list)) else json.dumps(v))' "$1" "$2" 2>/dev/null; }

# expect NAME JSON 'boolean expression over d'
expect() {
  local name="$1" json="$2" cond="$3"
  if python3 -c 'import json,sys
d=json.loads(sys.argv[1])
sys.exit(0 if eval(sys.argv[2]) else 1)' "$json" "$cond" 2>/dev/null; then
    pass "$name"
  else
    fail "$name" "$json"
  fi
}

# The lab server restarts now and then: wait for it instead of failing.
# (Its messages go to stderr: it also runs inside $(...) captures.)
wait_server() {
  local announced=0
  for _ in $(seq 1 120); do
    if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$SERVER/api/health/live")" = "200" ]; then
      [ "$announced" = "1" ] && say "        the server is back" >&2
      return 0
    fi
    [ "$announced" = "0" ] && say "        the server is not answering, waiting for it" >&2 && announced=1
    sleep 2
  done
  say "        the server did not come back" >&2
  return 1
}

# ev_net [timeout] <<'JS' : like ev, for scripts that need the server. A
# network failure (the script throws) is retried after the server is back.
ev_net() {
  local timeout="${1:-30}" script result
  script="$(cat)"
  for attempt in 1 2 3; do
    wait_server
    if [ "$attempt" -gt 1 ]; then
      # let the app notice the server again before asking
      auto_post /automation/network '{"reachable":null}' >/dev/null
      sleep 1
    fi
    result="$(printf '%s' "$script" | ev "$timeout")"
    if python3 -c 'import json,sys
d=json.loads(sys.argv[1]); sys.exit(0 if d.get("ok") else 1)' "$result" 2>/dev/null; then
      break
    fi
    say "        attempt $attempt failed ($(jq_py "$result" 'd.get("error")')), retrying" >&2
  done
  printf '%s' "$result"
}

launch() {
  # launch [ENV=VALUE ...] [-- app arguments]
  local envs=() args=()
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; args=("$@"); break; fi
    envs+=("$1"); shift
  done
  env DOCMORE_DATA_DIR="$DATA" DOCMORE_AUTOMATION_PORT="$PORT" DOCMORE_AUTOMATION_TOKEN="$TOKEN" \
    DOCMORE_AUTOMATION_DOWNLOAD_DIR="$ART/downloads" \
    ${envs[@]+"${envs[@]}"} "$APP" ${args[@]+"${args[@]}"} >>"$ART/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 80); do
    if auto_get /automation/state >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then say "the app exited during launch (see $ART/app.log)"; return 1; fi
    sleep 0.25
  done
  say "the automation server did not come up"
  return 1
}

quit_app() {
  [ -n "$APP_PID" ] || return 0
  auto_post /automation/quit "${1:-{\}}" >/dev/null 2>&1
  for _ in $(seq 1 120); do
    kill -0 "$APP_PID" 2>/dev/null || { APP_PID=""; return 0; }
    sleep 0.25
  done
  kill "$APP_PID" 2>/dev/null
  APP_PID=""
}

wait_loaded() {
  for _ in $(seq 1 240); do
    local state
    state="$(auto_get /automation/state)"
    if python3 -c 'import json,sys
d=json.loads(sys.argv[1]); w=d["windows"]
sys.exit(0 if (w and w[0]["loaded"] and not w[0]["loading"]) else 1)' "$state" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

# wait_state 'boolean expression over d' [seconds]
wait_state() {
  local cond="$1" seconds="${2:-30}" state=""
  for _ in $(seq 1 $((seconds * 4))); do
    state="$(auto_get /automation/state)"
    if python3 -c 'import json,sys
d=json.loads(sys.argv[1])
sys.exit(0 if eval(sys.argv[2]) else 1)' "$state" "$cond" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

server_api() {
  # server_api PATH JSON : a call straight to the server with the app's current token
  local access
  access="$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1])); print(list(d.values())[0]["accessToken"])' "$DATA/tokens.json" 2>/dev/null)"
  curl -s -m 30 -X POST -H "Authorization: Bearer $access" -H 'Content-Type: application/json' --data-binary "$2" "$SERVER$1"
}

cleanup() {
  local code=$?
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    # delete what the run created while the token still works, then erase
    for page in ${CREATED_PAGES[@]+"${CREATED_PAGES[@]}"}; do
      server_api /api/pages/delete "{\"pageId\":\"$page\"}" >/dev/null 2>&1
    done
    quit_app '{"erase":true}'
  fi
  for dir in ${WEBDATA_DIRS[@]+"${WEBDATA_DIRS[@]}"}; do
    case "$dir" in */WebKit/com.dezik.docmore/WebsiteDataStore/*) rm -rf "$dir" ;; esac
  done
  if [ -n "$DEFAULTS_SUITE" ]; then
    defaults delete "$DEFAULTS_SUITE" >/dev/null 2>&1
    case "$DEFAULTS_SUITE" in com.dezik.docmore.test-*) rm -f "$HOME/Library/Preferences/$DEFAULTS_SUITE.plist" ;; esac
  fi
  rm -f "$TOKEN_FILE" "$TOKEN_FILE.2" "$DATA-member-token.json" 2>/dev/null
  if [ "${DOCMORE_E2E_KEEP:-0}" = "1" ]; then
    say "data directory kept: $DATA"
  else
    rm -rf "$DATA"
  fi
  exit "$code"
}
trap cleanup EXIT

say "Docmore Mac end-to-end"
say "  app       $APP"
say "  server    $SERVER"
say "  data dir  $DATA"
say "  artifacts $ART"

# ---------------------------------------------------------------- server
section "Server"
wait_server
INFO="$(curl -s -m 10 "$SERVER/api/sync/info")"
expect "server answers /api/sync/info as docmore" "$INFO" 'd["data"]["app"] == "docmore" and d["data"]["sync"] >= 1'
SERVER_HASH="$(jq_py "$INFO" 'd["data"]["clientHash"]')"
if [ -z "$SERVER_HASH" ]; then
  say "the server is not reachable; nothing else can be checked"
  exit 1
fi

# two sign-ins from one login: the second one signs in again after a refused refresh
if "$HERE/dev-token.sh" --server "$SERVER" --out "$TOKEN_FILE" --count 2 >/dev/null 2>"$ART/dev-token.err"; then
  pass "test tokens minted (dev-token.sh)"
else
  fail "test tokens minted (dev-token.sh)" "$(cat "$ART/dev-token.err")"
  exit 1
fi

MEMBER_TOKEN_FILE="$DATA-member-token.json"
if "$HERE/dev-token.sh" --server "$SERVER" --user member --out "$MEMBER_TOKEN_FILE" >/dev/null 2>>"$ART/dev-token.err"; then
  pass "second test account minted (member)"
else
  rm -f "$MEMBER_TOKEN_FILE"
  skip "second test account minted (member)" "$(tail -1 "$ART/dev-token.err")"
fi

# ---------------------------------------------------------------- launch 1
section "First launch, empty data directory"
launch || exit 1
STATE="$(auto_get /automation/state)"
expect "starts with no account and shows the account picker" "$STATE" 'd["profiles"] == [] and d["windows"] == [] and d["pickerVisible"]'
expect "data directory and defaults suite are the test ones" "$STATE" "d['dataDir'] in ('$DATA', '$DATA_STD') and str(d['defaultsSuite']).startswith('com.dezik.docmore.test-')"
DEFAULTS_SUITE="$(jq_py "$STATE" 'd["defaultsSuite"]')"
auto_get "/automation/native-snapshot?which=picker" "$ART/00-picker.png"
UNAUTH="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/automation/state")"
[ "$UNAUTH" = "401" ] && pass "automation refuses a request without the token" || fail "automation refuses a request without the token" "$UNAUTH"

wait_server
SESSION="$(auto_post /automation/session "$(cat "$TOKEN_FILE")")"
rm -f "$TOKEN_FILE"
expect "session injected, web client downloaded, page loaded" "$SESSION" 'd["ok"] and d["loaded"] and len(d["profileId"]) == 16'
PROFILE="$(jq_py "$SESSION" 'd["profileId"]')"
STATE="$(auto_get /automation/state)"
WEBDATA_DIRS+=("$(jq_py "$STATE" 'd["profiles"][0]["webDataDirectory"]')")
BUNDLE_HASH="$(jq_py "$STATE" 'd["profiles"][0]["bundle"]["hash"]')"
INFO="$(curl -s -m 10 "$SERVER/api/sync/info")"
SERVER_HASH="$(jq_py "$INFO" 'd["data"]["clientHash"]')"
[ "$BUNDLE_HASH" = "$SERVER_HASH" ] && pass "installed bundle is the one the server serves ($BUNDLE_HASH)" || fail "installed bundle is the one the server serves" "app $BUNDLE_HASH server $SERVER_HASH"

BUNDLE_DIR="$DATA/profiles/$PROFILE/bundle/$BUNDLE_HASH"
VERIFY="$(python3 - "$BUNDLE_DIR" "$SERVER" <<'PY'
import hashlib, json, os, sys, urllib.request
root, server = sys.argv[1], sys.argv[2]
manifest = json.load(urllib.request.urlopen(server + "/api/sync/client-bundle", timeout=20))["data"]
missing, bad = 0, 0
for f in manifest["files"]:
    p = os.path.join(root, f["path"])
    if not os.path.isfile(p):
        missing += 1
        continue
    if hashlib.sha256(open(p, "rb").read()).hexdigest()[:32] != f["hash"]:
        bad += 1
print(json.dumps({"files": len(manifest["files"]), "missing": missing, "bad": bad, "hash": manifest["hash"]}))
PY
)"
expect "every file of the bundle is on disk with the right checksum" "$VERIFY" 'd["files"] > 100 and d["missing"] == 0 and d["bad"] == 0'

sleep 2
DOM="$(ev <<'JS'
return {
  href: location.href, origin: location.origin, title: document.title,
  text: document.body.innerText.slice(0, 600),
  rootChildren: document.getElementById("root") ? document.getElementById("root").children.length : 0,
  native: window.DOCMORE_NATIVE || null, secure: window.isSecureContext,
  hasHandler: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.docmore),
};
JS
)"
expect "page origin is docmore-app://<profile>/ and the path is /home" "$DOM" "d['value']['origin'] == 'docmore-app://$PROFILE' and d['value']['href'].endswith('/home')"
expect "the web client rendered (title, text, #root)" "$DOM" 'd["value"]["rootChildren"] > 0 and "Docmore" in d["value"]["title"] and len(d["value"]["text"]) > 80 and "Home" in d["value"]["text"]'
expect "window.DOCMORE_NATIVE is injected before the page scripts" "$DOM" "d['value']['native']['platform'] == 'mac' and d['value']['native']['serverUrl'] == '$SERVER' and 'files' in d['value']['native']['capabilities'] and len(d['value']['native']['deviceId']) > 10 and d['value']['hasHandler']"
auto_get /automation/snapshot "$ART/01-home.png"
SNAP_INFO="$(python3 - "$ART/01-home.png" <<'PY'
import json, os, struct, sys, zlib
p = sys.argv[1]
data = open(p, "rb").read() if os.path.exists(p) else b""
ok = data[:8] == b"\x89PNG\r\n\x1a\n"
w = h = 0
if ok:
    w, h = struct.unpack(">II", data[16:24])
print(json.dumps({"png": ok, "width": w, "height": h, "bytes": len(data)}))
PY
)"
expect "snapshot is a real PNG of the web view (01-home.png)" "$SNAP_INFO" 'd["png"] and d["width"] > 400 and d["height"] > 300 and d["bytes"] > 20000'

# ---------------------------------------------------------------- static files
section "Static files and routes from disk"
STATIC="$(ev <<'JS'
const head = async (path) => { const r = await fetch(path); const body = await r.text(); return { status: r.status, type: r.headers.get("content-type"), length: body.length, html: body.slice(0, 15).toLowerCase() }; };
const script = document.querySelector('script[type="module"][src]').getAttribute("src");
const css = document.querySelector('link[rel="stylesheet"][href]').getAttribute("href");
return {
  script: await head(script), css: await head(css), manifest: await head("/manifest.json"),
  spa: await head("/s/some-space/p/some-page-123"), missingAsset: await head("/assets/definitely-missing.js"),
  traversal: await head("/assets/%2e%2e/%2e%2e/tokens.json"),
};
JS
)"
expect "module script served as javascript" "$STATIC" 'd["value"]["script"]["status"] == 200 and "javascript" in d["value"]["script"]["type"]'
expect "stylesheet served as css" "$STATIC" 'd["value"]["css"]["status"] == 200 and "text/css" in d["value"]["css"]["type"]'
expect "manifest.json served as json" "$STATIC" 'd["value"]["manifest"]["status"] == 200 and "json" in d["value"]["manifest"]["type"]'
expect "a route without extension answers index.html" "$STATIC" 'd["value"]["spa"]["status"] == 200 and "text/html" in d["value"]["spa"]["type"] and "<!doctype html" in d["value"]["spa"]["html"]'
expect "a missing asset is 404, not index.html" "$STATIC" 'd["value"]["missingAsset"]["status"] == 404'
expect "path traversal is refused" "$STATIC" 'd["value"]["traversal"]["status"] in (400, 404)'

# ---------------------------------------------------------------- proxy bodies
section "API through the proxy"
BODIES="$(ev_net 180 <<'JS'
const out = {};
const j = async (path, body) => { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const spaces = await j("/api/spaces", { page: 1, limit: 5 });
out.spaces = spaces.status;
const spaceId = spaces.json.data.items[0].id;
out.spaceId = spaceId;
out.spaceSlug = spaces.json.data.items[0].slug;
const title = "mac-e2e " + Date.now();
const created = await j("/api/pages/create", { spaceId, title });
out.create = created.status;
const pageId = created.json.data.id;
out.pageId = pageId;
const info = await j("/api/pages/info", { pageId });
out.readBackTitle = info.json && info.json.data && info.json.data.title === title;
// a large JSON body
const big = await j("/api/pages/create", { spaceId, title: title + " big", content: "# big\n\n" + "lorem ipsum ".repeat(40000), format: "markdown" });
out.big = big.status; out.bigId = big.json && big.json.data && big.json.data.id;
// cookies never travel: the document has none and a login answer sets none
out.cookie = document.cookie;
const mk = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const viaFetch = async (form) => { const r = await fetch("/api/files/upload", { method: "POST", body: form }); return { status: r.status, json: await r.json().catch(() => null) }; };
const viaXhr = (form) => new Promise((resolve) => { const x = new XMLHttpRequest(); x.open("POST", "/api/files/upload"); x.onloadend = () => { let json = null; try { json = JSON.parse(x.responseText); } catch (e) {} resolve({ status: x.status, json }); }; x.send(form); });
const roundTrip = async (name, bytes, sender) => {
  const form = new FormData(); form.append("pageId", pageId); form.append("file", new File([bytes], name, { type: "application/octet-stream" }));
  const res = await sender(form);
  const att = res.json && (res.json.data || res.json);
  const entry = { status: res.status };
  if (att && att.id) {
    entry.url = "/api/files/" + att.id + "/" + encodeURIComponent(att.fileName);
    const back = await fetch(entry.url);
    entry.get = back.status; entry.same = same(new Uint8Array(await back.arrayBuffer()), bytes);
  }
  return entry;
};
out.uploadFetch = await roundTrip("e2e-fetch.bin", mk(300000, 7), viaFetch);
out.uploadXhr = await roundTrip("e2e-xhr.bin", mk(3000000, 11), viaXhr);
out.blob = (await fetch("/api/spaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: new Blob([JSON.stringify({ page: 1, limit: 1 })], { type: "application/json" }) })).status;
// the 3 MB file read as a stream
const stream = await fetch(out.uploadXhr.url); const reader = stream.body.getReader(); let chunks = 0, bytes = 0;
while (true) { const { done, value } = await reader.read(); if (done) break; chunks++; bytes += value.length; }
out.download = { chunks, bytes };
return out;
JS
)"
expect "JSON POST with a body: page created and read back" "$BODIES" 'd["value"]["spaces"] == 200 and d["value"]["create"] == 200 and d["value"]["readBackTitle"]'
expect "large JSON body (480 KB) arrives whole" "$BODIES" 'd["value"]["big"] == 200'
expect "multipart upload by fetch round-trips byte for byte" "$BODIES" 'd["value"]["uploadFetch"]["status"] == 200 and d["value"]["uploadFetch"]["get"] == 200 and d["value"]["uploadFetch"]["same"]'
expect "multipart upload by XMLHttpRequest (3 MB) round-trips byte for byte" "$BODIES" 'd["value"]["uploadXhr"]["status"] == 200 and d["value"]["uploadXhr"]["same"]'
expect "Blob body arrives" "$BODIES" 'd["value"]["blob"] == 200'
expect "no cookie is visible to the page" "$BODIES" 'd["value"]["cookie"] == ""'
expect "a 3 MB download read through a stream reader is complete" "$BODIES" 'd["value"]["download"]["bytes"] == 3000000 and d["value"]["download"]["chunks"] >= 1'
say "        $(jq_py "$BODIES" '"%d chunks" % d["value"]["download"]["chunks"]')"
PAGE_ID="$(jq_py "$BODIES" 'd["value"]["pageId"]')"
BIG_ID="$(jq_py "$BODIES" 'd["value"]["bigId"]')"
SPACE_ID="$(jq_py "$BODIES" 'd["value"]["spaceId"]')"
SPACE_SLUG="$(jq_py "$BODIES" 'd["value"]["spaceSlug"]')"
FILE_URL="$(jq_py "$BODIES" 'd["value"]["uploadFetch"]["url"]')"
FILE2_URL="$(jq_py "$BODIES" 'd["value"]["uploadXhr"]["url"]')"
[ -n "$PAGE_ID" ] && CREATED_PAGES+=("$PAGE_ID")
[ -n "$BIG_ID" ] && [ "$BIG_ID" != "None" ] && CREATED_PAGES+=("$BIG_ID")

AI="$(ev_net <<'JS'
const r = await fetch("/api/ai/config", { method: "POST" }); const j = await r.json().catch(() => null);
return { status: r.status, generative: !!(j && j.data && j.data.generative) };
JS
)"
if [ "$(jq_py "$AI" 'd["value"]["generative"]')" = "True" ]; then
  SSE="$(ev_net 240 <<'JS'
const t0 = performance.now();
const r = await fetch("/api/ai/generate/stream", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "text/event-stream" }, body: JSON.stringify({ action: "custom", content: "Count from one to twelve in words, one per line.", prompt: "Follow the instruction exactly." }) });
const reader = r.body.getReader(); const decoder = new TextDecoder();
const times = []; let text = "";
while (true) { const { done, value } = await reader.read(); if (done) break; times.push(Math.round(performance.now() - t0)); text += decoder.decode(value, { stream: true }); }
return { status: r.status, type: r.headers.get("content-type"), chunks: times.length, spreadMs: times.length ? times[times.length - 1] - times[0] : 0, events: (text.match(/^data:/gm) || []).length, done: text.includes("[DONE]") };
JS
)"
  expect "server-sent events stream incrementally (AI generate)" "$SSE" 'd["value"]["status"] == 200 and "text/event-stream" in d["value"]["type"] and d["value"]["chunks"] >= 4 and d["value"]["spreadMs"] >= 150 and d["value"]["done"]'
  say "        $(jq_py "$SSE" '"%d chunks over %d ms, %d events" % (d["value"]["chunks"], d["value"]["spreadMs"], d["value"]["events"])')"
else
  skip "server-sent events stream incrementally" "AI is not configured on this server"
fi

# ---------------------------------------------------------------- token refresh
section "Token refresh"
BEFORE="$(shasum -a 256 "$DATA/tokens.json" | cut -d' ' -f1)"
MODE="$(stat -f '%Lp' "$DATA/tokens.json")"
[ "$MODE" = "600" ] && pass "token file store is mode 0600" || fail "token file store is mode 0600" "$MODE"
wait_server
auto_post /automation/token '{"accessToken":"not-a-real-token","expiresIn":3600}' >/dev/null
REFRESH="$(ev_net 60 <<'JS'
// eight requests discover the dead token at once: one refresh must serve them all
const calls = await Promise.all(Array.from({ length: 8 }, () => fetch("/api/users/me", { method: "POST" }).then((r) => r.status)));
return { statuses: calls };
JS
)"
expect "a refused access token is renewed once and every request retried" "$REFRESH" 'd["value"]["statuses"] == [200] * 8'
AFTER="$(shasum -a 256 "$DATA/tokens.json" | cut -d' ' -f1)"
[ "$BEFORE" != "$AFTER" ] && pass "the rotated refresh token was stored" || fail "the rotated refresh token was stored" "token file unchanged"
STATE="$(auto_get /automation/state)"
expect "the account does not need a new sign-in" "$STATE" 'd["profiles"][0]["needsSignIn"] == False'

# ---------------------------------------------------------------- bridge
section "Bridge"
BRIDGE="$(ev_net 120 <<JS
const original = window.__docmoreNativeReply;
const waiting = new Map();
window.__docmoreNativeReply = (id, error, result) => {
  const entry = waiting.get(id);
  if (!entry) return original && original(id, error, result);
  waiting.delete(id);
  error ? entry.reject(new Error(error)) : entry.resolve(result);
};
let n = 0;
const call = (type, payload) => new Promise((resolve, reject) => {
  const id = "e2e-" + (++n);
  waiting.set(id, { resolve, reject });
  window.webkit.messageHandlers.docmore.postMessage({ id, type, payload: payload || null });
  setTimeout(() => reject(new Error("no answer to " + type)), 60000);
});
window.__e2eCall = call;
window.__e2eEvents = [];
window.addEventListener("docmore:native", (event) => window.__e2eEvents.push(event.detail));
const out = {};
out.probe = await call("net.probe");
out.ensure = await call("files.ensure", { urls: ["$FILE_URL", "/api/files/00000000-0000-7000-8000-000000000000/nope.bin"] });
// the 3 MB file is over the limit, the 300 KB one under it
out.limited = await call("files.ensure", { urls: ["$FILE2_URL", "$FILE_URL"], maxBytes: 1000000 });
out.has = await call("files.has", { urls: ["$FILE_URL", "$FILE2_URL"] });
const note = "written offline " + Date.now();
out.note = note;
out.put = await call("files.put", { url: "/api/files/11111111-1111-7111-8111-111111111111/offline note.txt?v=1", base64: btoa(note), contentType: "text/plain" });
out.usage = await call("files.usage");
out.notify = await call("notify", { title: "e2e", body: "hello", path: "/home" });
out.badge = await call("badge", { count: 7 });
out.spotlight = await call("spotlight.index", { items: [{ id: "e2e-page-1", title: "E2E page", text: "body text", path: "/settings/account/profile" }] });
out.state = await call("state", { online: true, pending: 3, syncing: false, conflicts: 0 });
try { await call("no.such.type"); out.unknown = "answered"; } catch (e) { out.unknown = String(e.message); }
return out;
JS
)"
expect "net.probe answers reachable" "$BRIDGE" 'd["value"]["probe"]["reachable"] == True'
expect "files.ensure downloads into the offline cache and reports failures" "$BRIDGE" "d['value']['ensure']['ok'] == ['$FILE_URL'] and len(d['value']['ensure']['failed']) == 1"
expect "files.ensure with maxBytes skips the larger file and lists it as failed" "$BRIDGE" "d['value']['limited']['ok'] == ['$FILE_URL'] and d['value']['limited']['failed'] == ['$FILE2_URL']"
expect "files.has / files.put / files.usage" "$BRIDGE" "d['value']['has']['present'] == ['$FILE_URL'] and d['value']['put']['ok'] and d['value']['usage']['count'] == 2 and d['value']['usage']['bytes'] > 300000"
expect "an unknown message type answers with an error" "$BRIDGE" '"Unknown message type" in d["value"]["unknown"]'
STATE="$(auto_get /automation/state)"
expect "notify reaches the notification sink with its path" "$STATE" 'any(n["title"] == "e2e" and n["path"] == "/home" for n in d["notifications"])'
expect "badge sets the Dock badge" "$STATE" 'd["dockBadge"] == "7"'
expect "spotlight.index is recorded for the account" "$STATE" 'd["profiles"][0]["spotlightItems"] == 1 and any(s["op"] == "index" and s["ids"] == ["e2e-page-1"] for s in d["spotlight"])'
expect "state from the page shows in the native status" "$STATE" 'd["profiles"][0]["sync"]["pending"] == 3 and "3" in d["profiles"][0]["status"]'
[ -f "$DATA/profiles/$PROFILE/files/index.json" ] && pass "file cache index is on disk in the data directory" || fail "file cache index is on disk in the data directory"

# ---------------------------------------------------------------- links and downloads
section "Links and downloads"
wait_server
ev >/dev/null <<'JS'
window.__e2eClick = (href, download, target) => { const a = document.createElement("a"); a.href = href; if (download) a.download = download; if (target) a.target = target; document.body.appendChild(a); a.click(); a.remove(); };
window.__e2eClick(URL.createObjectURL(new Blob(["blob download body"], { type: "text/plain" })), "e2e-blob.txt");
return true;
JS
for _ in $(seq 1 40); do [ -f "$ART/downloads/e2e-blob.txt" ] && break; sleep 0.25; done
ev >/dev/null <<JS
window.__e2eClick("$FILE_URL", "e2e-attachment.bin");
return true;
JS
for _ in $(seq 1 40); do [ -f "$ART/downloads/e2e-fetch.bin" ] && break; sleep 0.25; done
ev >/dev/null <<'JS'
window.__e2eClick("https://example.com/docmore-e2e-link");
return true;
JS
sleep 0.5
[ "$(cat "$ART/downloads/e2e-blob.txt" 2>/dev/null)" = "blob download body" ] && pass "a blob: download is written where the save panel points" || fail "a blob: download is written where the save panel points" "$(ls "$ART/downloads")"
ATTACH="$(python3 - "$ART/downloads/e2e-fetch.bin" <<'PY'
import json, os, sys
p = sys.argv[1]
data = open(p, "rb").read() if os.path.exists(p) else b""
good = len(data) == 300000 and all(data[i] == ((i * 31 + 7) & 255) for i in range(0, len(data), 997))
print(json.dumps({"bytes": len(data), "good": good}))
PY
)"
expect "an attachment link with download saves the file through the app" "$ATTACH" 'd["good"]'
STATE="$(auto_get /automation/state)"
expect "a link to another host goes to the default browser, the page stays" "$STATE" '"https://example.com/docmore-e2e-link" in d["externalOpened"] and d["windows"][0]["url"].startswith("docmore-app://")'
ev >/dev/null <<'JS'
const a = document.createElement("a"); a.href = "/home"; a.target = "_blank"; document.body.appendChild(a); a.click(); a.remove();
return true;
JS
if wait_state 'len(d["windows"]) == 2 and d["windows"][1]["loaded"] and d["windows"][0]["tabs"] == 2' 20; then
  pass "target=_blank to the app itself opens a new tab"
else
  fail "target=_blank to the app itself opens a new tab" "$(auto_get /automation/state)"
fi
auto_post /automation/window '{"action":"close","window":1}' >/dev/null
sleep 0.5
auto_post /automation/window '{"action":"front","window":0}' >/dev/null

# ---------------------------------------------------------------- commands and links
section "Commands, links, tabs and windows"
auto_post /automation/command '{"id":"settings"}' >/dev/null
sleep 1
NAV="$(ev <<'JS'
return { path: location.pathname, commands: window.__e2eEvents.filter((e) => e.type === "command").map((e) => e.payload.id) };
JS
)"
expect "command reaches the page and the page acts on it (settings)" "$NAV" 'd["value"]["commands"] == ["settings"] and d["value"]["path"].startswith("/settings")'
auto_post /automation/deeplink '{"url":"docmore://open?path=/home"}' >/dev/null
sleep 1
NAV="$(ev <<'JS'
return { path: location.pathname, navigates: window.__e2eEvents.filter((e) => e.type === "navigate").map((e) => e.payload.path) };
JS
)"
expect "docmore://open?path=/home navigates the front window" "$NAV" 'd["value"]["path"] == "/home" and d["value"]["navigates"] == ["/home"]'
auto_post /automation/spotlight-open "{\"identifier\":\"$PROFILE|e2e-page-1\"}" >/dev/null
sleep 1
NAV="$(ev <<'JS'
return { path: location.pathname };
JS
)"
expect "opening a Spotlight result navigates to its path" "$NAV" 'd["value"]["path"] == "/settings/account/profile"'
BAD="$(auto_post /automation/deeplink '{"url":"docmore://open?path=//evil.example.com/x"}')"
expect "a deep link that leaves the app is refused" "$BAD" 'd["ok"] == False'

auto_post /automation/window '{"action":"new-tab","path":"/home"}' >/dev/null
STATE="$(auto_get /automation/state)"
expect "new tab: two tabs in one window" "$STATE" 'len(d["windows"]) == 2 and all(w["tabs"] == 2 for w in d["windows"]) and all(w["loaded"] for w in d["windows"])'
auto_post /automation/window '{"action":"new-window","path":"/home"}' >/dev/null
STATE="$(auto_get /automation/state)"
expect "new window: a third web view in its own window" "$STATE" 'len(d["windows"]) == 3 and sorted(w["tabs"] for w in d["windows"]) == [1, 2, 2]'
auto_post /automation/window '{"action":"close","window":2}' >/dev/null
auto_post /automation/window '{"action":"close","window":1}' >/dev/null
sleep 0.5
auto_post /automation/window '{"action":"front","window":0}' >/dev/null

# ---------------------------------------------------------------- persistence
section "Relaunch: IndexedDB, restored window, bundle update"
wait_server
RUN_MARK="run-$STAMP-$RANDOM"
WRITE="$(ev <<JS
const db = await new Promise((resolve, reject) => { const open = indexedDB.open("docmore-e2e", 1); open.onupgradeneeded = () => open.result.createObjectStore("kv"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
await new Promise((resolve, reject) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put("$RUN_MARK", "mark"); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
db.close();
localStorage.setItem("docmore-e2e", "$RUN_MARK");
return { ok: true, path: location.pathname };
JS
)"
expect "IndexedDB and localStorage written" "$WRITE" 'd["value"]["ok"]'
sleep 1.2   # the window state is saved shortly after the last change
quit_app
[ -f "$DATA/windows.json" ] && pass "window state saved on quit" || fail "window state saved on quit"

# make the installed copy look like an older bundle: one file differs
OLD_HASH="$(python3 - "$DATA/profiles/$PROFILE/bundle" <<'PY'
import hashlib, json, os, sys
root = sys.argv[1]
current = json.load(open(os.path.join(root, "current.json")))
folder = os.path.join(root, current["hash"])
manifest = json.load(open(os.path.join(folder, ".manifest.json")))
target = next(f for f in manifest["files"] if f["path"] == "manifest.json")
stale = b'{"name":"Docmore (stale copy made by e2e)"}'
open(os.path.join(folder, "manifest.json"), "wb").write(stale)
target["hash"] = hashlib.sha256(stale).hexdigest()[:32]
target["size"] = len(stale)
old = hashlib.sha256(("\n".join("%s:%s" % (f["path"], f["hash"]) for f in manifest["files"])).encode()).hexdigest()[:32]
manifest["hash"] = old
json.dump(manifest, open(os.path.join(folder, ".manifest.json"), "w"))
os.rename(folder, os.path.join(root, old))
json.dump({"hash": old, "version": current["version"]}, open(os.path.join(root, "current.json"), "w"))
print(old)
PY
)"
say "        installed copy relabelled as older bundle $OLD_HASH"

wait_server
launch || exit 1
if wait_loaded; then pass "relaunch opens the saved window with no sign-in"; else fail "relaunch opens the saved window with no sign-in" "$(auto_get /automation/state)"; fi
STATE="$(auto_get /automation/state)"
expect "the window is back on the page it showed" "$STATE" 'len(d["windows"]) == 1 and d["windows"][0]["path"] == "/settings/account/profile"'
READ="$(ev <<'JS'
const db = await new Promise((resolve, reject) => { const open = indexedDB.open("docmore-e2e", 1); open.onupgradeneeded = () => open.result.createObjectStore("kv"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
const value = await new Promise((resolve, reject) => { const request = db.transaction("kv").objectStore("kv").get("mark"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
db.close();
return { idb: value || null, local: localStorage.getItem("docmore-e2e") };
JS
)"
expect "IndexedDB written before the relaunch is still there" "$READ" "d['value']['idb'] == '$RUN_MARK'"
expect "localStorage survived too" "$READ" "d['value']['local'] == '$RUN_MARK'"

INFO="$(curl -s -m 10 "$SERVER/api/sync/info")"
SERVER_HASH="$(jq_py "$INFO" 'd["data"]["clientHash"]')"
if wait_state "d['profiles'][0]['bundle']['hash'] == '$SERVER_HASH'" 60; then
  pass "a newer bundle on the server is downloaded in the background"
else
  fail "a newer bundle on the server is downloaded in the background" "$(auto_get /automation/state)"
fi
STATE="$(auto_get /automation/state)"
expect "the previous bundle is kept" "$STATE" "d['profiles'][0]['bundle']['previousHash'] == '$OLD_HASH'"
REUSE="$(python3 - "$DATA/profiles/$PROFILE/bundle" "$OLD_HASH" "$SERVER_HASH" <<'PY'
import json, os, sys
root, old, new = sys.argv[1:4]
shared = changed = 0
for base, _, files in os.walk(os.path.join(new)) if False else os.walk(os.path.join(root, new)):
    for name in files:
        if name == ".manifest.json":
            continue
        path = os.path.join(base, name)
        rel = os.path.relpath(path, os.path.join(root, new))
        other = os.path.join(root, old, rel)
        if os.path.exists(other) and os.stat(other).st_ino == os.stat(path).st_ino:
            shared += 1
        else:
            changed += 1
print(json.dumps({"shared": shared, "changed": changed, "manifestIsReal": b"stale copy" not in open(os.path.join(root, new, "manifest.json"), "rb").read()}))
PY
)"
expect "unchanged files were reused (hard links), only the changed one downloaded" "$REUSE" 'd["shared"] > 100 and d["changed"] == 1 and d["manifestIsReal"]'
STALE="$(ev <<'JS'
const r = await fetch("/manifest.json"); return { body: (await r.text()).slice(0, 80) };
JS
)"
expect "the page already open keeps the bundle it started with" "$STALE" '"stale copy" in d["value"]["body"]'
auto_post /automation/reload >/dev/null
FRESH="$(ev <<'JS'
const r = await fetch("/manifest.json"); return { body: (await r.text()).slice(0, 80), root: document.getElementById("root").children.length };
JS
)"
expect "the next load uses the new bundle" "$FRESH" '"stale copy" not in d["value"]["body"] and d["value"]["root"] > 0'

# ---------------------------------------------------------------- unreachable
section "Server unreachable"
ev >/dev/null <<'JS'
window.__e2eEvents = [];
window.addEventListener("docmore:native", (event) => window.__e2eEvents.push(event.detail));
const original = window.__docmoreNativeReply; const waiting = new Map();
window.__docmoreNativeReply = (id, error, result) => { const entry = waiting.get(id); if (!entry) return original && original(id, error, result); waiting.delete(id); error ? entry.reject(new Error(error)) : entry.resolve(result); };
let n = 0;
window.__e2eCall = (type, payload) => new Promise((resolve, reject) => { const id = "e2e-" + (++n); waiting.set(id, { resolve, reject }); window.webkit.messageHandlers.docmore.postMessage({ id, type, payload: payload || null }); setTimeout(() => reject(new Error("no answer to " + type)), 30000); });
return true;
JS
NET="$(auto_post /automation/network '{"reachable":false}')"
expect "automation forces the server unreachable" "$NET" "d['forcedUnreachable'] == True and d['reachable']['$PROFILE'] == False"
sleep 0.5
OFFLINE="$(ev 60 <<JS
const out = {};
out.events = window.__e2eEvents.filter((e) => e.type === "net.changed").map((e) => e.payload.reachable);
out.probe = await window.__e2eCall("net.probe");
try { const r = await fetch("/api/users/me", { method: "POST" }); out.api = "answered " + r.status; } catch (e) { out.api = e.name + ": " + e.message; }
try { const r = await fetch("/api/spaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: 1, limit: 1 }) }); out.apiBody = "answered " + r.status; } catch (e) { out.apiBody = e.name; }
out.xhr = await new Promise((resolve) => { const x = new XMLHttpRequest(); x.open("POST", "/api/users/me"); x.onerror = () => resolve("error"); x.onload = () => resolve("answered " + x.status); x.send(); });
const cached = await fetch("$FILE_URL");
const bytes = new Uint8Array(await cached.arrayBuffer());
let good = bytes.length === 300000; for (let i = 0; good && i < bytes.length; i++) if (bytes[i] !== ((i * 31 + 7) & 255)) good = false;
out.cached = { status: cached.status, source: cached.headers.get("x-docmore-source"), good, type: cached.headers.get("content-type") };
const ranged = await fetch("$FILE_URL", { headers: { Range: "bytes=10-19" } });
out.ranged = { status: ranged.status, range: ranged.headers.get("content-range"), length: (await ranged.arrayBuffer()).byteLength };
const put = await fetch("/api/files/11111111-1111-7111-8111-111111111111/offline%20note.txt");
out.put = { status: put.status, text: await put.text(), type: put.headers.get("content-type") };
const absent = await fetch("$FILE2_URL");
out.absent = absent.status;
const asset = await fetch(document.querySelector('script[type="module"][src]').getAttribute("src"));
out.asset = asset.status;
return out;
JS
)"
expect "net.changed { reachable: false } reaches the page" "$OFFLINE" 'd["value"]["events"] == [False]'
expect "net.probe answers unreachable" "$OFFLINE" 'd["value"]["probe"]["reachable"] == False'
expect "/api calls fail as network errors (fetch rejects, XHR onerror), not as HTTP answers" "$OFFLINE" 'd["value"]["api"].startswith("TypeError") and d["value"]["apiBody"] == "TypeError" and d["value"]["xhr"] == "error"'
expect "a cached file is served from disk while unreachable" "$OFFLINE" 'd["value"]["cached"]["status"] == 200 and d["value"]["cached"]["source"] == "offline-cache" and d["value"]["cached"]["good"]'
expect "a byte range of a cached file is honoured" "$OFFLINE" 'd["value"]["ranged"]["status"] == 206 and d["value"]["ranged"]["range"] == "bytes 10-19/300000" and d["value"]["ranged"]["length"] == 10'
expect "bytes stored with files.put resolve offline" "$OFFLINE" 'd["value"]["put"]["status"] == 200 and d["value"]["put"]["text"].startswith("written offline") and "text/plain" in d["value"]["put"]["type"]'
expect "a file that is not cached answers 404" "$OFFLINE" 'd["value"]["absent"] == 404'
expect "static files still come from disk" "$OFFLINE" 'd["value"]["asset"] == 200'

RELOAD="$(auto_post /automation/reload)"
expect "reload while unreachable completes" "$RELOAD" 'd["ok"] and d["loaded"]'
sleep 2
SHELL_DOM="$(ev <<'JS'
return { root: document.getElementById("root") ? document.getElementById("root").children.length : 0, title: document.title, text: document.body.innerText.slice(0, 300), native: !!window.DOCMORE_NATIVE, path: location.pathname };
JS
)"
expect "the app shell loads from disk with the server unreachable" "$SHELL_DOM" 'd["value"]["root"] > 0 and d["value"]["native"] and len(d["value"]["text"]) > 20'
auto_get /automation/snapshot "$ART/02-unreachable.png"
STATE="$(auto_get /automation/state)"
expect "the native status says offline" "$STATE" 'd["profiles"][0]["reachable"] == False and "Offline" in d["profiles"][0]["status"]'

ev >/dev/null <<'JS'
window.__e2eEvents = [];
window.addEventListener("docmore:native", (event) => window.__e2eEvents.push(event.detail));
return true;
JS
NET="$(auto_post /automation/network '{"reachable":null}')"
expect "back to the real network: the server is reachable again" "$NET" "d['forcedUnreachable'] == False and d['reachable']['$PROFILE'] == True"
sleep 0.5
BACK="$(ev_net 60 <<'JS'
const r = await fetch("/api/users/me", { method: "POST" });
return { events: window.__e2eEvents.filter((e) => e.type === "net.changed").map((e) => e.payload.reachable), api: r.status };
JS
)"
expect "net.changed { reachable: true } reaches the page and /api works again" "$BACK" 'd["value"]["events"] == [True] and d["value"]["api"] == 200'

REFRESHED="$(ev_net 60 <<JS
// online again: reading a cached file goes to the server and refreshes the copy
const r = await fetch("$FILE_URL"); await r.arrayBuffer();
return { status: r.status, source: r.headers.get("x-docmore-source") };
JS
)"
expect "online, a cached file comes from the server again" "$REFRESHED" 'd["value"]["status"] == 200 and d["value"]["source"] == None'

# ---------------------------------------------------------------- web offline engine
section "Web client offline engine under the custom scheme"
wait_server
PREP="$(ev_net 90 <<JS
const j = async (path, body) => { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
if (!window.__docmoreOffline) return { engine: false };
const created = await j("/api/pages/create", { spaceId: "$SPACE_ID", title: "mac-e2e offline page" });
const pageId = created.json.data.id, slugId = created.json.data.slugId;
// a real 2x2 PNG
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYmBgYGBAQAOCQEDVv9g1QAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const form = new FormData(); form.append("pageId", pageId); form.append("file", new File([png], "e2e-pixel.png", { type: "image/png" }));
const uploaded = await (await fetch("/api/files/upload", { method: "POST", body: form })).json();
const attachment = uploaded.data || uploaded;
const src = "/api/files/" + attachment.id + "/" + attachment.fileName;
const update = await j("/api/pages/update", { pageId, operation: "replace", format: "json", content: { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "Kept on this Mac by the e2e run." }] },
  { type: "image", attrs: { src, attachmentId: attachment.id, width: "100%" } },
] } });
return { engine: true, pageId, slugId, src, update: update.status };
JS
)"
OFF_PAGE="$(jq_py "$PREP" 'd["value"].get("pageId")')"
OFF_SLUG="$(jq_py "$PREP" 'd["value"].get("slugId")')"
OFF_SRC="$(jq_py "$PREP" 'd["value"].get("src")')"
[ -n "$OFF_PAGE" ] && [ "$OFF_PAGE" != "None" ] && CREATED_PAGES+=("$OFF_PAGE")
PIN='{"ok":true,"value":{"engine":false}}'
if [ "$(jq_py "$PREP" 'd["value"]["engine"]')" = "True" ]; then
  # the person opens the page, then marks it "available offline"
  auto_post /automation/navigate "{\"path\":\"/s/$SPACE_SLUG/p/$OFF_SLUG\"}" >/dev/null
  PIN="$(ev_net 150 <<JS
$E2E_HELPERS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = window.__docmoreOffline;
const pageId = "$OFF_PAGE", src = "$OFF_SRC";
let editor = null;
for (let i = 0; i < 60 && !(editor && editor.innerText.includes("Kept on this Mac")); i++) { editor = document.querySelector(".editor-container .ProseMirror"); await sleep(500); }
const opened = !!(editor && editor.innerText.includes("Kept on this Mac"));
await engine.pin("page", pageId, true);
const has = (list) => (list || []).some((x) => x === pageId || (x && x.id === pageId));
let downloaded = false;
for (let i = 0; i < 160 && !downloaded; i++) { downloaded = has(await engine.downloaded()); if (!downloaded) await sleep(500); }
// give the engine a moment to hand the image to the shell
let present = { present: [] };
for (let i = 0; i < 40 && !present.present.length; i++) { present = await window.__e2eCall("files.has", { urls: [src] }); if (!present.present.length) await sleep(500); }
return { engine: true, opened, update: 200, downloaded, imageCached: present.present.length === 1, status: engine.status() };
JS
)"
fi
if [ "$(jq_py "$PIN" 'd["value"]["engine"]')" != "True" ]; then
  skip "offline engine checks" "this web client has no window.__docmoreOffline"
else
  expect "the page opens in the editor online" "$PIN" 'd["value"]["opened"]'
  expect "a pinned page is downloaded to the device (IndexedDB under docmore-app://)" "$PIN" 'd["value"]["downloaded"]'
  expect "the page's image was handed to the native file cache" "$PIN" 'd["value"]["imageCached"]'

  auto_post /automation/network '{"reachable":false}' >/dev/null
  auto_post /automation/reload >/dev/null
  OFFPAGE="$(ev 90 <<JS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let editor = null;
for (let i = 0; i < 60 && !(editor && editor.innerText.includes("Kept on this Mac")); i++) { editor = document.querySelector(".editor-container .ProseMirror"); await sleep(500); }
const out = { editor: !!editor, text: editor ? editor.innerText.slice(0, 200) : document.body.innerText.slice(0, 300) };
let image = null;
for (let i = 0; i < 40; i++) { image = editor && Array.from(editor.querySelectorAll("img")).find((x) => (x.getAttribute("src") || "").includes("e2e-pixel")); if (image && image.complete && image.naturalWidth > 0) break; await sleep(500); }
out.image = image ? { src: image.getAttribute("src"), width: image.naturalWidth } : null;
const direct = await fetch("$OFF_SRC");
out.direct = { status: direct.status, source: direct.headers.get("x-docmore-source"), bytes: (await direct.arrayBuffer()).byteLength };
try { const r = await fetch("/api/health/live", { cache: "no-store" }); out.probe = "answered " + r.status; } catch (e) { out.probe = e.name; }
const engine = window.__docmoreOffline;
out.connectivity = window.__docmoreConnectivity ? window.__docmoreConnectivity.state() : null;
out.pendingBefore = engine.status().pending;
try {
  const made = await engine.request("/pages/create", { spaceId: "$SPACE_ID", title: "mac-e2e made offline" });
  const page = (made && made.data && made.data.id) ? made.data : made;
  out.made = { id: page && page.id, title: page && page.title, slugId: page && page.slugId };
} catch (e) { out.made = { error: String(e && e.message || e) }; }
await sleep(800);
out.pendingAfter = engine.status().pending;
return out;
JS
)"
  expect "unreachable: the pinned page opens from the device after a full reload" "$OFFPAGE" 'd["value"]["editor"] and "Kept on this Mac by the e2e run." in d["value"]["text"]'
  expect "unreachable: the page's image is drawn from the native file cache" "$OFFPAGE" 'd["value"]["image"] and d["value"]["image"]["width"] > 0 and d["value"]["direct"]["status"] == 200 and d["value"]["direct"]["source"] == "offline-cache"'
  expect "unreachable: fetch(\"/api/health/live\") is a network error for the page" "$OFFPAGE" 'd["value"]["probe"] == "TypeError"'
  expect "unreachable: the page knows it is offline" "$OFFPAGE" 'd["value"]["connectivity"] and d["value"]["connectivity"]["reachable"] == False'
  expect "unreachable: a page is created on the device and waits in the queue" "$OFFPAGE" 'd["value"]["made"].get("id") and d["value"]["pendingAfter"] > d["value"]["pendingBefore"]'
  auto_get /automation/snapshot "$ART/02b-pinned-page-offline.png"
  MADE_ID="$(jq_py "$OFFPAGE" 'd["value"]["made"].get("id")')"
  STATE="$(auto_get /automation/state)"
  expect "the queue shows in the native status" "$STATE" 'd["profiles"][0]["sync"]["pending"] >= 1'

  wait_server
  auto_post /automation/network '{"reachable":null}' >/dev/null
  DRAIN="$(ev 150 <<'JS'
const engine = window.__docmoreOffline;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pending = engine.status().pending;
for (let i = 0; i < 200 && pending > 0; i++) { await sleep(500); pending = engine.status().pending; if (i === 20 || i === 80) { try { await engine.sync(); } catch (e) {} } }
return { pending, conflicts: engine.status().conflicts, lastError: engine.status().lastError };
JS
)"
  expect "reachable again: the queue drains to zero" "$DRAIN" 'd["value"]["pending"] == 0'
  if [ -n "$MADE_ID" ] && [ "$MADE_ID" != "None" ]; then
    CREATED_PAGES+=("$MADE_ID")
    ON_SERVER="$(server_api /api/pages/info "{\"pageId\":\"$MADE_ID\"}")"
    expect "the page made offline exists on the server" "$ON_SERVER" 'd["data"]["title"] == "mac-e2e made offline"'
  else
    fail "the page made offline exists on the server" "no page id came back offline"
  fi
fi

# ---------------------------------------------------------------- refused refresh
section "Refused refresh token: data kept, sign in again"
wait_server
auto_post /automation/token '{"accessToken":"dead-access","refreshToken":"dead-refresh","expiresIn":3600}' >/dev/null
REFUSED="$(ev_net 60 <<'JS'
const r = await fetch("/api/users/me", { method: "POST" });
return { status: r.status };
JS
)"
expect "with a refused refresh token the page gets a plain 401" "$REFUSED" 'd["value"]["status"] == 401'
if wait_state 'd["profiles"][0]["needsSignIn"] and any(w["signInSheet"] for w in d["windows"])' 20; then
  pass "the account is marked and the sign-in sheet is up"
else
  fail "the account is marked and the sign-in sheet is up" "$(auto_get /automation/state)"
fi
KEPT="$(ev <<'JS'
const db = await new Promise((resolve, reject) => { const open = indexedDB.open("docmore-e2e", 1); open.onupgradeneeded = () => open.result.createObjectStore("kv"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
const value = await new Promise((resolve, reject) => { const request = db.transaction("kv").objectStore("kv").get("mark"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
db.close();
return { idb: value || null };
JS
)"
expect "local data is kept while the account waits for a sign-in" "$KEPT" "d['value']['idb'] == '$RUN_MARK'"
[ -d "$DATA/profiles/$PROFILE/bundle" ] && pass "the web client and files stay on disk" || fail "the web client and files stay on disk"
wait_server
AGAIN="$(auto_post /automation/session "$(cat "$TOKEN_FILE.2")")"
rm -f "$TOKEN_FILE.2"
expect "signing in as the same person continues the same account" "$AGAIN" "d['ok'] and d['profileId'] == '$PROFILE'"
if wait_state 'd["profiles"][0]["needsSignIn"] == False and not any(w["signInSheet"] for w in d["windows"]) and len(d["profiles"]) == 1' 20; then
  pass "the mark is cleared and the sheet goes away"
else
  fail "the mark is cleared and the sheet goes away" "$(auto_get /automation/state)"
fi
CONTINUED="$(ev_net 60 <<'JS'
const r = await fetch("/api/users/me", { method: "POST" });
const db = await new Promise((resolve, reject) => { const open = indexedDB.open("docmore-e2e", 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
const value = await new Promise((resolve, reject) => { const request = db.transaction("kv").objectStore("kv").get("mark"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
db.close();
return { status: r.status, idb: value || null };
JS
)"
expect "after signing in again the API answers and the data is the same" "$CONTINUED" "d['value']['status'] == 200 and d['value']['idb'] == '$RUN_MARK'"

# ---------------------------------------------------------------- two accounts
section "Two accounts"
if [ -f "$MEMBER_TOKEN_FILE" ]; then
  wait_server
  SECOND="$(auto_post /automation/session "$(cat "$MEMBER_TOKEN_FILE")")"
  rm -f "$MEMBER_TOKEN_FILE"
  expect "a second account signs in and opens its own window" "$SECOND" "d['ok'] and d['loaded'] and d['profileId'] != '$PROFILE'"
  PROFILE2="$(jq_py "$SECOND" 'd["profileId"]')"
  STATE="$(auto_get /automation/state)"
  WEBDATA_DIRS+=("$(jq_py "$STATE" "[p for p in d['profiles'] if p['id'] == '$PROFILE2'][0]['webDataDirectory']")")
  expect "two accounts, each with its own origin, web client and window" "$STATE" "len(d['profiles']) == 2 and len(set(p['origin'] for p in d['profiles'])) == 2 and all('bundle' in p for p in d['profiles']) and sorted(w['profileId'] for w in d['windows']) == sorted(['$PROFILE', '$PROFILE2'])"
  MEMBER_WINDOW="$(jq_py "$STATE" "[w['index'] for w in d['windows'] if w['profileId'] == '$PROFILE2'][0]")"
  ADMIN_WINDOW="$(jq_py "$STATE" "[w['index'] for w in d['windows'] if w['profileId'] == '$PROFILE'][0]")"
  EV_WINDOW="$MEMBER_WINDOW"
  ISOLATED="$(ev_net 60 <<'JS'
const me = await (await fetch("/api/users/me", { method: "POST" })).json();
const names = await indexedDB.databases();
localStorage.setItem("docmore-e2e-member", "1");
return { origin: location.origin, userId: me.data.user.id, role: me.data.user.role, sees: localStorage.getItem("docmore-e2e"), e2eDb: names.some((n) => n.name === "docmore-e2e") };
JS
)"
  EV_WINDOW="$ADMIN_WINDOW"
  ADMIN_SIDE="$(ev_net 60 <<'JS'
const me = await (await fetch("/api/users/me", { method: "POST" })).json();
return { origin: location.origin, userId: me.data.user.id, sees: localStorage.getItem("docmore-e2e"), member: localStorage.getItem("docmore-e2e-member") };
JS
)"
  EV_WINDOW=""
  expect "each window talks to the server as its own user" "$ISOLATED" "d['value']['origin'] == 'docmore-app://$PROFILE2' and d['value']['userId'] != '$(jq_py "$ADMIN_SIDE" 'd["value"]["userId"]')'"
  expect "web data is separate: the second account sees none of the first one's" "$ISOLATED" 'd["value"]["sees"] == None and d["value"]["e2eDb"] == False'
  expect "and the first sees none of the second one's" "$ADMIN_SIDE" "d['value']['sees'] == '$RUN_MARK' and d['value']['member'] == None"
  auto_post /automation/window "{\"action\":\"switch\",\"profileId\":\"$PROFILE\"}" >/dev/null
  STATE="$(auto_get /automation/state)"
  expect "Switch Account brings the other account forward" "$STATE" "d['activeProfileId'] == '$PROFILE'"
  OUT="$(auto_post /automation/sign-out "{\"profileId\":\"$PROFILE2\"}")"
  expect "signing one account out leaves the other alone" "$OUT" 'd["ok"] and d["profiles"] == 1'
  STATE="$(auto_get /automation/state)"
  expect "the remaining account keeps its window and data" "$STATE" "len(d['windows']) == 1 and d['windows'][0]['profileId'] == '$PROFILE' and d['profiles'][0]['id'] == '$PROFILE'"
  [ ! -d "$DATA/profiles/$PROFILE2" ] && [ -d "$DATA/profiles/$PROFILE" ] && pass "only the signed-out account's folder is erased" || fail "only the signed-out account's folder is erased"
  auto_post /automation/window '{"action":"front","window":0}' >/dev/null
else
  skip "two accounts" "no second test account"
fi

# ---------------------------------------------------------------- quick note
section "Quick note"
wait_server
NOTE_TITLE="mac-e2e quick note $STAMP"
auto_post /automation/network '{"reachable":false}' >/dev/null
QUEUED="$(auto_post /automation/quick-capture "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1] + "\n\nWritten while the server was away.", "spaceId": sys.argv[2]}))' "$NOTE_TITLE" "$SPACE_ID")")"
expect "unreachable: the note is kept on disk" "$QUEUED" "d['ok'] and len(d['queue']) == 1 and d['queue'][0]['title'] == '$NOTE_TITLE'"
[ "$(ls "$DATA/capture-queue" 2>/dev/null | wc -l | tr -d ' ')" = "1" ] && pass "the queue file is in the data directory" || fail "the queue file is in the data directory" "$(ls "$DATA/capture-queue" 2>&1)"
wait_server
auto_post /automation/network '{"reachable":null}' >/dev/null
for _ in $(seq 1 80); do
  LIST="$(auto_post /automation/quick-capture '{"action":"list"}')"
  [ "$(jq_py "$LIST" 'len(d["queue"])')" = "0" ] && break
  sleep 0.5
done
expect "reachable again: the queue empties by itself" "$LIST" 'len(d["queue"]) == 0'
FOUND="$(server_api /api/pages/recent "{\"spaceId\":\"$SPACE_ID\",\"limit\":30}" | python3 -c 'import json,sys
title = sys.argv[1]
try:
    items = json.load(sys.stdin)["data"]["items"]
except Exception:
    items = []
match = [p for p in items if p.get("title") == title]
print(json.dumps({"count": len(match), "id": match[0]["id"] if match else None}))' "$NOTE_TITLE")"
expect "the note became exactly one page on the server" "$FOUND" 'd["count"] == 1'
NOTE_PAGE="$(jq_py "$FOUND" 'd["id"]')"
[ -n "$NOTE_PAGE" ] && [ "$NOTE_PAGE" != "None" ] && CREATED_PAGES+=("$NOTE_PAGE")
if [ -n "$NOTE_PAGE" ] && [ "$NOTE_PAGE" != "None" ]; then
  BODY="$(server_api /api/pages/info "{\"pageId\":\"$NOTE_PAGE\",\"includeContent\":true}")"
  expect "with its body" "$BODY" '"Written while the server was away." in json.dumps(d["data"])'
fi
PANEL="$(auto_post /automation/quick-capture '{"action":"show"}')"
expect "the quick note panel opens" "$PANEL" 'd["panelVisible"]'
sleep 0.6
auto_get "/automation/native-snapshot?which=panel" "$ART/06-quick-note-panel.png"
auto_post /automation/quick-capture '{"action":"close"}' >/dev/null

# ---------------------------------------------------------------- meetings
section "Meetings"
meeting_done_pages() {
  # page ids of the meeting.done events sent to the page so far, one per line
  auto_get "/automation/bridge-log?type=meeting.done" | python3 -c 'import json,sys
for entry in json.load(sys.stdin)["entries"]:
    try:
        page = json.loads(entry["payload"])["p"].get("pageId")
    except Exception:
        page = None
    print(page or "-")'
}
PREVIEW="$(auto_post /automation/meeting-preview '{"show":true}')"
expect "the recording panel opens (preview, nothing is recorded)" "$PREVIEW" 'd["panelVisible"]'
sleep 0.6
auto_get "/automation/native-snapshot?which=panel" "$ART/08-recording-panel.png"
auto_post /automation/meeting-preview '{"show":false}' >/dev/null
if [ ! -f "$MEETING_WAV" ]; then
  skip "meetings" "no speech sample at $MEETING_WAV (set DOCMORE_E2E_MEETING_WAV)"
else
  wait_server
  MEET="$(auto_get /automation/meetings)"
  expect "the meeting engine is in the build, with its models; the default is a large-v3 turbo" "$MEET" 'd["available"] and any(m["id"] == "openai_whisper-tiny" for m in d["models"]) and "large-v3" in d["selectedModel"] and "turbo" in d["selectedModel"]'
  if [ "$(jq_py "$MEET" 'd["available"]')" = "True" ]; then
    request() { python3 -c 'import json,sys; print(json.dumps({"path": sys.argv[1], "spaceId": sys.argv[2], "title": sys.argv[3], "model": "openai_whisper-tiny"}))' "$MEETING_WAV" "$SPACE_ID" "$1"; }
    ONLINE="$(auto_post /automation/transcribe-file "$(request "mac-e2e meeting $STAMP")")"
    expect "a WAV is transcribed on this Mac (WhisperKit, tiny model): the text has \"homepage\"" "$ONLINE" 'd["ok"] and "homepage" in d["transcript"].lower() and d["language"] == "en" and d["segments"] >= 3 and 14 < d["durationSeconds"] < 20'
    say "        $(jq_py "$ONLINE" 'd.get("transcript", "")[:150]')"
    expect "the transcript was queued and sent at once" "$ONLINE" 'd.get("jobId") and d["jobs"] == []'
    MODEL_FILES="$(find "$DATA/models" -type f 2>/dev/null | wc -l | tr -d ' ')"
    [ "$MODEL_FILES" -gt 5 ] && pass "the model was downloaded into the data directory ($(du -sh "$DATA/models" | cut -f1 | tr -d ' '))" || fail "the model was downloaded into the data directory" "$MODEL_FILES files"
    # keep the downloaded model for the next run (only a complete one)
    if [ "$(jq_py "$ONLINE" 'd["ok"]')" = "True" ] && [ ! -d "$MODEL_CACHE" ]; then
      cp -Rc "$DATA/models" "$MODEL_CACHE" 2>/dev/null || cp -R "$DATA/models" "$MODEL_CACHE"
    fi
    DONE_PAGE=""
    for _ in $(seq 1 120); do
      DONE_PAGE="$(meeting_done_pages | head -1)"
      [ -n "$DONE_PAGE" ] && break
      sleep 2
    done
    if [ -n "$DONE_PAGE" ] && [ "$DONE_PAGE" != "-" ]; then
      pass "meeting.done { pageId } reaches the page once the server wrote the notes"
      CREATED_PAGES+=("$DONE_PAGE")
      NOTES="$(server_api /api/pages/info "{\"pageId\":\"$DONE_PAGE\",\"includeContent\":true}")"
      expect "the page on the server has the notes (homepage, Maria, Tom)" "$NOTES" 'all(word in json.dumps(d["data"]) for word in ("homepage", "Maria", "Tom"))'
      STATE="$(auto_get /automation/state)"
      expect "a notification says the notes are ready and leads to the page" "$STATE" "any(n['kind'] == 'meeting-done' and n.get('path') == '/p/$DONE_PAGE' for n in d['notifications'])"
    else
      fail "meeting.done { pageId } reaches the page once the server wrote the notes" "events: $(meeting_done_pages | tr '\n' ' ')"
    fi

    auto_post /automation/network '{"reachable":false}' >/dev/null
    OFF="$(auto_post /automation/transcribe-file "$(request "mac-e2e meeting offline $STAMP")")"
    expect "unreachable: transcribed all the same, the transcript waits in the queue" "$OFF" 'd["ok"] and "homepage" in d["transcript"].lower() and len(d["jobs"]) == 1 and d["jobs"][0]["state"] == "waiting"'
    JOB_FILES="$(find "$DATA/meetings/jobs/$PROFILE" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
    [ "$JOB_FILES" = "1" ] && pass "the job is a file in the data directory" || fail "the job is a file in the data directory" "$JOB_FILES files"
    STATE="$(auto_get /automation/state)"
    expect "meeting.state counts it as queued" "$STATE" 'd["meeting"]["queued"] == 1 and d["meeting"]["recording"] == False'
    wait_server
    auto_post /automation/network '{"reachable":null}' >/dev/null
    for _ in $(seq 1 60); do
      MEET="$(auto_get /automation/meetings)"
      [ "$(jq_py "$MEET" 'len(d["jobs"])')" = "0" ] && break
      sleep 1
    done
    expect "reachable again: the queue sends it by itself" "$MEET" 'd["jobs"] == [] and d["state"]["queued"] == 0'
    SECOND_PAGE=""
    for _ in $(seq 1 120); do
      SECOND_PAGE="$(meeting_done_pages | sed -n 2p)"
      [ -n "$SECOND_PAGE" ] && break
      sleep 2
    done
    if [ -n "$SECOND_PAGE" ] && [ "$SECOND_PAGE" != "-" ]; then
      pass "and its notes land on a page too"
      CREATED_PAGES+=("$SECOND_PAGE")
    else
      fail "and its notes land on a page too" "events: $(meeting_done_pages | tr '\n' ' ')"
    fi
  fi
fi

# ---------------------------------------------------------------- meeting detection
section "Meeting detection"
auto_post /automation/mic-activity '{"inUse":true}' >/dev/null
auto_post /automation/mic-activity '{"inUse":false}' >/dev/null
auto_post /automation/mic-activity '{"inUse":true}' >/dev/null
STATE="$(auto_get /automation/state)"
expect "another app taking the microphone raises one offer to record, not two" "$STATE" 'len([n for n in d["notifications"] if n["kind"] == "meeting-detected"]) == 1'

# ---------------------------------------------------------------- lock
section "Lock"
LOCK="$(auto_post /automation/lock '{"action":"enable"}')"
LOCK="$(auto_post /automation/lock '{"action":"lock"}')"
expect "locking hides every window's page" "$LOCK" 'd["locked"] and d["windowsLocked"] and all(d["windowsLocked"])'
STATE="$(auto_get /automation/state)"
expect "a locked window shows neither the page nor its title" "$STATE" 'all(w["webViewHidden"] and w["title"] == "Docmore" for w in d["windows"])'
auto_get "/automation/native-snapshot?which=front" "$ART/07-locked.png"
auto_post /automation/window '{"action":"settings"}' >/dev/null
STATE="$(auto_get /automation/state)"
expect "Settings stays closed while locked" "$STATE" 'd["settingsVisible"] == False'

# ---------------------------------------------------------------- cold offline launch
section "Cold launch with the server unreachable, in Spanish"
sleep 1.2
quit_app
launch DOCMORE_AUTOMATION_OFFLINE=1 DOCMORE_AUTOMATION_HOTKEY=1 -- -AppleLanguages '(es)' || exit 1
if wait_loaded; then pass "offline launch opens from the stored bundle"; else fail "offline launch opens from the stored bundle" "$(auto_get /automation/state)"; fi
STATE="$(auto_get /automation/state)"
expect "with the lock on, the app starts locked" "$STATE" 'd["locked"] and all(w["locked"] and w["webViewHidden"] for w in d["windows"])'
LOCK="$(auto_post /automation/lock '{"action":"unlock"}')"
expect "unlocking shows the pages again" "$LOCK" 'd["locked"] == False and not any(d["windowsLocked"])'
auto_post /automation/lock '{"action":"disable"}' >/dev/null
HOTKEY="$(auto_post /automation/quick-capture '{"action":"list"}')"
expect "the quick note shortcut registers system-wide (Option-Command-N)" "$HOTKEY" 'd["hotKeyRegistered"] and d["hotKey"] == "\u2325\u2318N"'
expect "no update feed configured: the update menu item is hidden" "$STATE" 'd["updaterConfigured"] == False and d["updateMenuHidden"]'
sleep 2
COLD="$(ev <<'JS'
return { root: document.getElementById("root") ? document.getElementById("root").children.length : 0, text: document.body.innerText.slice(0, 200), origin: location.origin };
JS
)"
expect "the page renders with no server at all" "$COLD" 'd["value"]["root"] > 0 and len(d["value"]["text"]) > 20'
STATE="$(auto_get /automation/state)"
expect "menus are in Spanish" "$STATE" 'd["menus"][1:] == ["Archivo", "Edición", "Visualización", "Ir", "Cuenta", "Ventana", "Ayuda"]'
expect "status line is in Spanish" "$STATE" '"Sin conexi" in d["profiles"][0]["status"]'
auto_get /automation/snapshot "$ART/03-cold-offline.png"
auto_get "/automation/native-snapshot?which=front" "$ART/04-window-es.png"
for tab in general accounts offline meetings security; do
  auto_post /automation/window "{\"action\":\"settings\",\"tab\":\"$tab\"}" >/dev/null
  sleep 0.6
  auto_get "/automation/native-snapshot?which=settings" "$ART/05-settings-$tab-es.png"
done
STATE="$(auto_get /automation/state)"
expect "the Settings window opens" "$STATE" 'd["settingsVisible"]'
auto_post /automation/network '{"reachable":null}' >/dev/null

# ---------------------------------------------------------------- sign out
section "Clean up and sign out"
wait_server
sleep 3   # let the app see the server again
DELETED=0
for page in ${CREATED_PAGES[@]+"${CREATED_PAGES[@]}"}; do
  CODE="$(server_api /api/pages/delete "{\"pageId\":\"$page\"}" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("status", 0))
except Exception: print(0)')"
  [ "$CODE" = "200" ] && DELETED=$((DELETED + 1))
done
[ "$DELETED" = "${#CREATED_PAGES[@]}" ] && pass "test pages deleted ($DELETED)" || fail "test pages deleted" "$DELETED of ${#CREATED_PAGES[@]}"
CREATED_PAGES=()

OLD_REFRESH_FILE="$ART/.refresh"
python3 -c 'import json,sys
d=json.load(open(sys.argv[1])); t=list(d.values())[0]
json.dump({"grant_type":"refresh_token","refresh_token":t["refreshToken"],"client_id":sys.argv[3]}, open(sys.argv[2],"w"))' \
  "$DATA/tokens.json" "$OLD_REFRESH_FILE" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["profiles"][0]["clientId"])' "$DATA/profiles.json")"
chmod 600 "$OLD_REFRESH_FILE"
WEBDATA="${WEBDATA_DIRS[0]}"
ev >/dev/null <<'JS'
window.webkit.messageHandlers.docmore.postMessage({ id: null, type: "signOut", payload: null });
return true;
JS
if wait_state 'd["profiles"] == [] and d["windows"] == [] and d["pickerVisible"]' 40; then
  pass "the page's Sign out closes the windows and returns to the account picker"
else
  fail "the page's Sign out closes the windows and returns to the account picker" "$(auto_get /automation/state)"
fi
[ ! -d "$DATA/profiles/$PROFILE" ] && pass "the account folder (bundle, files) is erased" || fail "the account folder (bundle, files) is erased"
TOKENS_LEFT="$(python3 -c 'import json,sys
try: print(len(json.load(open(sys.argv[1]))))
except Exception: print(0)' "$DATA/tokens.json")"
[ "$TOKENS_LEFT" = "0" ] && pass "the stored tokens are erased" || fail "the stored tokens are erased" "$TOKENS_LEFT left"
SITE_DATA="$(find "$WEBDATA" -type f \( -path '*IndexedDB*' -o -path '*LocalStorage*' -o -name '*.sqlite3' \) -size +0 2>/dev/null | grep -v 'salt$' | wc -l | tr -d ' ')"
[ "$SITE_DATA" = "0" ] && pass "the web data (IndexedDB, localStorage) is erased" || fail "the web data (IndexedDB, localStorage) is erased" "$(find "$WEBDATA" -type f | head -20)"
REVOKED="$(curl -s -m 15 -X POST -H 'Content-Type: application/json' --data-binary "@$OLD_REFRESH_FILE" "$SERVER/api/oauth/token")"
rm -f "$OLD_REFRESH_FILE"
expect "the refresh token was revoked on the server" "$REVOKED" 'd.get("error") == "invalid_grant"'

# WebKit keeps a signed-out store open until the app quits: the next launch removes it
sleep 0.5
quit_app
launch || exit 1
for _ in $(seq 1 40); do [ ! -d "$WEBDATA" ] && break; sleep 0.25; done
[ ! -d "$WEBDATA" ] && pass "the emptied web data store is removed at the next launch" || fail "the emptied web data store is removed at the next launch" "$WEBDATA"
quit_app '{"erase":true}'
LEFT="$(defaults read "$DEFAULTS_SUITE" 2>/dev/null | grep -c '=' || true)"
[ "${LEFT:-0}" = "0" ] && pass "the test defaults suite is emptied" || fail "the test defaults suite is emptied" "$(defaults read "$DEFAULTS_SUITE" 2>&1 | head -10)"

section "Result"
say "  passed $PASS, failed $FAIL, skipped $SKIP"
say "  artifacts: $ART"
if [ "$FAIL" -gt 0 ]; then
  for name in "${FAILED_NAMES[@]}"; do say "  failed: $name"; done
  exit 1
fi
exit 0
