#!/bin/bash
# Mints OAuth tokens for the Docmore Mac app without the consent click:
# cookie session -> register a public client -> approve -> token.
#
# Usage: tools/dev-token.sh [--server URL] [--user admin|member] [--out FILE] [--count N]
#
# Writes a JSON file { serverUrl, clientId, accessToken, refreshToken } with
# mode 0600 and prints only its path. Never prints credential values.
# With --count N it mints N independent sign-ins from one login and writes
# FILE, FILE.2 ... FILE.N (a refresh token rotates, so a test that needs to
# sign in twice needs two).
# The login endpoint is throttled: mint once per test run and reuse the files.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SERVER="http://localhost:3100"
WHO="admin"
OUT=""
COUNT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --user) WHO="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
SERVER="${SERVER%/}"

if [ ! -f "$REPO/.env" ]; then
  echo "missing $REPO/.env (LOCAL_TEST_ADMIN_EMAIL / LOCAL_TEST_ADMIN_PASSWORD)" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. "$REPO/.env"
set +a

if [ "$WHO" = "member" ]; then
  EMAIL="${LOCAL_TEST_MEMBER_EMAIL:-}"
  PASSWORD="${LOCAL_TEST_MEMBER_PASSWORD:-}"
else
  EMAIL="${LOCAL_TEST_ADMIN_EMAIL:-}"
  PASSWORD="${LOCAL_TEST_ADMIN_PASSWORD:-}"
fi
if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "test credentials for '$WHO' are not set in .env" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/docmore-token.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies"
[ -n "$OUT" ] || OUT="$WORK/../docmore-dev-token-$WHO.json"

json() { python3 -c "$1" "${@:2}"; }

# 1. cookie session
EMAIL="$EMAIL" PASSWORD="$PASSWORD" json 'import json,os;print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"]}))' > "$WORK/login.json"
CODE=$(curl -sS -m 20 -o "$WORK/login.out" -w '%{http_code}' -c "$JAR" \
  -H 'Content-Type: application/json' --data-binary "@$WORK/login.json" "$SERVER/api/auth/login")
if [ "$CODE" != "200" ]; then
  echo "login failed with HTTP $CODE (throttled? wait a minute)" >&2
  exit 1
fi

# 2. public client
DEVICE="$(scutil --get ComputerName 2>/dev/null || hostname)"
DEVICE="$DEVICE" json 'import json,os;print(json.dumps({"client_name":"Docmore for Mac (%s, dev-token)"%os.environ["DEVICE"],"redirect_uris":["docmore://oauth/callback"],"token_endpoint_auth_method":"none","scope":"app"}))' > "$WORK/register.json"
CODE=$(curl -sS -m 20 -o "$WORK/register.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' --data-binary "@$WORK/register.json" "$SERVER/api/oauth/register")
if [ "$CODE" != "201" ]; then
  echo "client registration failed with HTTP $CODE" >&2
  exit 1
fi
CLIENT_ID=$(json 'import json,sys;print(json.load(open(sys.argv[1]))["client_id"])' "$WORK/register.out")

# 3 and 4, once per requested sign-in: PKCE + approval with the cookie, then the token
umask 077
for INDEX in $(seq 1 "$COUNT"); do
  VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
  CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')
  STATE=$(openssl rand -hex 12)
  CLIENT_ID="$CLIENT_ID" CHALLENGE="$CHALLENGE" STATE="$STATE" json 'import json,os;print(json.dumps({"client_id":os.environ["CLIENT_ID"],"redirect_uri":"docmore://oauth/callback","response_type":"code","code_challenge":os.environ["CHALLENGE"],"code_challenge_method":"S256","scope":"app","state":os.environ["STATE"],"approved":True}))' > "$WORK/authorize.json"
  CODE=$(curl -sS -m 20 -o "$WORK/authorize.out" -w '%{http_code}' -b "$JAR" \
    -H 'Content-Type: application/json' --data-binary "@$WORK/authorize.json" "$SERVER/api/oauth/authorize")
  if [ "$CODE" != "200" ]; then
    echo "authorize failed with HTTP $CODE" >&2
    exit 1
  fi
  AUTH_CODE=$(json 'import json,sys,urllib.parse as u
d=json.load(open(sys.argv[1]))
d=d.get("data",d)
q=u.parse_qs(u.urlparse(d["redirectUrl"]).query)
print(q["code"][0])' "$WORK/authorize.out")

  CLIENT_ID="$CLIENT_ID" AUTH_CODE="$AUTH_CODE" VERIFIER="$VERIFIER" json 'import json,os;print(json.dumps({"grant_type":"authorization_code","code":os.environ["AUTH_CODE"],"redirect_uri":"docmore://oauth/callback","client_id":os.environ["CLIENT_ID"],"code_verifier":os.environ["VERIFIER"]}))' > "$WORK/token.json"
  CODE=$(curl -sS -m 20 -o "$WORK/token.out" -w '%{http_code}' \
    -H 'Content-Type: application/json' --data-binary "@$WORK/token.json" "$SERVER/api/oauth/token")
  if [ "$CODE" != "200" ]; then
    echo "token exchange failed with HTTP $CODE" >&2
    exit 1
  fi

  TARGET="$OUT"
  [ "$INDEX" -gt 1 ] && TARGET="$OUT.$INDEX"
  SERVER="$SERVER" CLIENT_ID="$CLIENT_ID" json 'import json,os,sys
t=json.load(open(sys.argv[1]))
out={"serverUrl":os.environ["SERVER"],"clientId":os.environ["CLIENT_ID"],"accessToken":t["access_token"],"refreshToken":t["refresh_token"],"expiresIn":t.get("expires_in",3600)}
json.dump(out,open(sys.argv[2],"w"))' "$WORK/token.out" "$TARGET"
  chmod 600 "$TARGET"
  echo "$TARGET"
done
