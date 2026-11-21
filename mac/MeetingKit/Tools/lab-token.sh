#!/bin/bash
# Mints an OAuth access token for a Docmore server without the consent click,
# for MeetingKit's end-to-end run. Same approach as mac/tools/dev-token.sh:
# cookie session -> register a public client -> approve with PKCE -> token.
#
# Usage: Tools/lab-token.sh [--server URL] [--out FILE] [--force]
#
# Writes { serverUrl, accessToken } to FILE (mode 0600) and prints only the
# path. Never prints credential values. The login endpoint is throttled: an
# existing FILE whose token still works is reused (no login) unless --force.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PACKAGE/../.." && pwd)"
SERVER="http://localhost:3100"
OUT="$PACKAGE/.build/scratch/lab-token.json"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
SERVER="${SERVER%/}"

json() { python3 -c "$1" "${@:2}"; }

# Reuse a token that still works.
if [ "$FORCE" = "0" ] && [ -f "$OUT" ]; then
  TOKEN_HEADER="$(mktemp "${TMPDIR:-/tmp}/meetingkit-header.XXXXXX")"
  trap 'rm -f "$TOKEN_HEADER"' EXIT
  json 'import json,sys
d=json.load(open(sys.argv[1]))
open(sys.argv[2],"w").write("Authorization: Bearer "+d["accessToken"]) if d.get("serverUrl")==sys.argv[3] else None' "$OUT" "$TOKEN_HEADER" "$SERVER"
  if [ -s "$TOKEN_HEADER" ]; then
    CODE=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -H @"$TOKEN_HEADER" \
      -H 'Content-Type: application/json' --data-binary '{}' "$SERVER/api/users/me" || true)
    if [ "$CODE" = "200" ]; then
      echo "$OUT"
      exit 0
    fi
  fi
  rm -f "$TOKEN_HEADER"
  trap - EXIT
fi

if [ ! -f "$REPO/.env" ]; then
  echo "missing $REPO/.env (LOCAL_TEST_ADMIN_EMAIL / LOCAL_TEST_ADMIN_PASSWORD)" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. "$REPO/.env"
set +a
EMAIL="${LOCAL_TEST_ADMIN_EMAIL:-}"
PASSWORD="${LOCAL_TEST_ADMIN_PASSWORD:-}"
if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "the test credentials are not set in .env" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/meetingkit-token.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies"

# 1. cookie session
EMAIL="$EMAIL" PASSWORD="$PASSWORD" json 'import json,os;print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"]}))' > "$WORK/login.json"
CODE=$(curl -sS -m 20 -o "$WORK/login.out" -w '%{http_code}' -c "$JAR" \
  -H 'Content-Type: application/json' --data-binary "@$WORK/login.json" "$SERVER/api/auth/login")
if [ "$CODE" != "200" ]; then
  echo "login failed with HTTP $CODE (throttled? wait a minute)" >&2
  exit 1
fi

# 2. public client
json 'import json;print(json.dumps({"client_name":"MeetingKit test","redirect_uris":["docmore://oauth/callback"],"token_endpoint_auth_method":"none","scope":"app"}))' > "$WORK/register.json"
CODE=$(curl -sS -m 20 -o "$WORK/register.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' --data-binary "@$WORK/register.json" "$SERVER/api/oauth/register")
if [ "$CODE" != "201" ] && [ "$CODE" != "200" ]; then
  echo "client registration failed with HTTP $CODE" >&2
  exit 1
fi
CLIENT_ID=$(json 'import json,sys;print(json.load(open(sys.argv[1]))["client_id"])' "$WORK/register.out")

# 3. PKCE + approval with the cookie
VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')
CLIENT_ID="$CLIENT_ID" CHALLENGE="$CHALLENGE" json 'import json,os;print(json.dumps({"client_id":os.environ["CLIENT_ID"],"redirect_uri":"docmore://oauth/callback","response_type":"code","code_challenge":os.environ["CHALLENGE"],"code_challenge_method":"S256","scope":"app","state":"x","approved":True}))' > "$WORK/authorize.json"
CODE=$(curl -sS -m 20 -o "$WORK/authorize.out" -w '%{http_code}' -b "$JAR" \
  -H 'Content-Type: application/json' --data-binary "@$WORK/authorize.json" "$SERVER/api/oauth/authorize")
if [ "$CODE" != "200" ]; then
  echo "authorize failed with HTTP $CODE" >&2
  exit 1
fi
AUTH_CODE=$(json 'import json,sys,urllib.parse as u
d=json.load(open(sys.argv[1]))
d=d.get("data",d)
print(u.parse_qs(u.urlparse(d["redirectUrl"]).query)["code"][0])' "$WORK/authorize.out")

# 4. the token
CLIENT_ID="$CLIENT_ID" AUTH_CODE="$AUTH_CODE" VERIFIER="$VERIFIER" json 'import json,os;print(json.dumps({"grant_type":"authorization_code","code":os.environ["AUTH_CODE"],"redirect_uri":"docmore://oauth/callback","client_id":os.environ["CLIENT_ID"],"code_verifier":os.environ["VERIFIER"]}))' > "$WORK/token.json"
CODE=$(curl -sS -m 20 -o "$WORK/token.out" -w '%{http_code}' \
  -H 'Content-Type: application/json' --data-binary "@$WORK/token.json" "$SERVER/api/oauth/token")
if [ "$CODE" != "200" ]; then
  echo "token exchange failed with HTTP $CODE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
umask 077
SERVER="$SERVER" json 'import json,os,sys
t=json.load(open(sys.argv[1]))
json.dump({"serverUrl":os.environ["SERVER"],"accessToken":t["access_token"]},open(sys.argv[2],"w"))' "$WORK/token.out" "$OUT"
chmod 600 "$OUT"
echo "$OUT"
