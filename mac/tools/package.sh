#!/bin/bash
# Builds the Release app and packages it as a zip and a DMG in mac/dist/.
#
#   tools/package.sh
#
# Without a signing identity the app is ad-hoc signed (it runs on this Mac;
# on another Mac Gatekeeper asks for a right-click > Open, or
# `xattr -dr com.apple.quarantine Docmore.app`).
#
# Optional environment:
#   SPARKLE_FEED_URL       appcast URL; turns on "Check for Updates..."
#   SPARKLE_PUBLIC_KEY     EdDSA public key printed by Sparkle's generate_keys
#   DOCMORE_SIGN_IDENTITY  "Developer ID Application: Name (TEAMID)"; signs with
#                          the hardened runtime and a secure timestamp
#   DOCMORE_TEAM_ID        team of that identity
#   DOCMORE_NOTARY_PROFILE keychain profile made with
#                          `xcrun notarytool store-credentials`; notarizes and
#                          staples the DMG
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAC="$(cd "$HERE/.." && pwd)"
OUT="$MAC/dist"
DERIVED="$MAC/build"

cd "$MAC"
if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate >/dev/null
elif [ ! -d Docmore.xcodeproj ]; then
  echo "xcodegen is needed to create Docmore.xcodeproj (brew install xcodegen)" >&2
  exit 1
fi
python3 "$HERE/gen-strings.py" --check >/dev/null

SETTINGS=()
[ -n "${SPARKLE_FEED_URL:-}" ] && SETTINGS+=("SPARKLE_FEED_URL=$SPARKLE_FEED_URL")
[ -n "${SPARKLE_PUBLIC_KEY:-}" ] && SETTINGS+=("SPARKLE_PUBLIC_KEY=$SPARKLE_PUBLIC_KEY")
if [ -n "${DOCMORE_SIGN_IDENTITY:-}" ]; then
  SETTINGS+=("CODE_SIGN_IDENTITY=$DOCMORE_SIGN_IDENTITY" "ENABLE_HARDENED_RUNTIME=YES" "OTHER_CODE_SIGN_FLAGS=--timestamp")
  [ -n "${DOCMORE_TEAM_ID:-}" ] && SETTINGS+=("DEVELOPMENT_TEAM=$DOCMORE_TEAM_ID")
fi

echo "Building Release..."
LOG="$DERIVED/package-build.log"
mkdir -p "$DERIVED"
if ! xcodebuild -project Docmore.xcodeproj -scheme Docmore -configuration Release \
  -derivedDataPath "$DERIVED" ${SETTINGS[@]+"${SETTINGS[@]}"} build >"$LOG" 2>&1; then
  grep -E "error:|BUILD FAILED" "$LOG" | head -20 >&2
  echo "build failed, full log: $LOG" >&2
  exit 1
fi

APP="$DERIVED/Build/Products/Release/Docmore.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
codesign --verify --deep --strict "$APP"
if strings "$APP/Contents/MacOS/Docmore" | grep -q "DOCMORE_AUTOMATION_PORT"; then
  echo "the automation server leaked into the Release build" >&2
  exit 1
fi

mkdir -p "$OUT"
ZIP="$OUT/Docmore-$VERSION.zip"
DMG="$OUT/Docmore-$VERSION.dmg"
rm -f "$ZIP" "$DMG"

echo "Packaging $VERSION ($BUILD)..."
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/docmore-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Docmore.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Docmore $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

if [ -n "${DOCMORE_SIGN_IDENTITY:-}" ]; then
  codesign --sign "$DOCMORE_SIGN_IDENTITY" --timestamp "$DMG"
  if [ -n "${DOCMORE_NOTARY_PROFILE:-}" ]; then
    echo "Notarizing..."
    xcrun notarytool submit "$DMG" --keychain-profile "$DOCMORE_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
    # the zip carries a stapled copy of the app
    xcrun stapler staple "$APP"
    rm -f "$ZIP"
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  fi
fi

SIGNATURE="$(codesign -dv "$APP" 2>&1 | grep -E '^Signature|^Authority' | head -1)"
echo "app        $APP"
echo "signature  ${SIGNATURE:-unknown}"
echo "zip        $ZIP ($(du -h "$ZIP" | cut -f1 | tr -d ' '))"
echo "dmg        $DMG ($(du -h "$DMG" | cut -f1 | tr -d ' '))"
