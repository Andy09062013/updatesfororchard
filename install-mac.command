#!/bin/bash
# Orchard installer for macOS.
# Double-click this file to install Orchard. It downloads the Chromium engine
# from Electron's official release, adds Orchard's files, signs the app so your
# Mac will run it, and puts Orchard in your Applications folder.
#
# Works on Apple Silicon (M1/M2/M3/M4) and Intel Macs. Nothing to install first.

set -e
REPO="https://raw.githubusercontent.com/Andy09062013/updatesfororchard/main"
ELECTRON_VER="45.2.3"
SHA_ARM64="4d7c429064087a47b855d9bd06c76ead4819b7f02b385de232d4a5c37ecef55f"
SHA_X64="d87323533cc8750ef177e5b48058f7a8b381f677d4e103cc63360006c08829c2"

say() { printf "\n\033[1;32m%s\033[0m\n" "$1"; }
die() { printf "\n\033[1;31m%s\033[0m\n" "$1"; echo "Press Return to close."; read _; exit 1; }

clear
echo "============================================"
echo "        Installing Orchard for Mac"
echo "============================================"

# --- pick the right build for this Mac -------------------------------------
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  EZIP="electron-v${ELECTRON_VER}-darwin-arm64.zip"; WANT="$SHA_ARM64"
else
  EZIP="electron-v${ELECTRON_VER}-darwin-x64.zip";   WANT="$SHA_X64"
fi

WORK="$(mktemp -d /tmp/orchard.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# --- download the Chromium engine (from Electron's official GitHub release) --
say "Downloading the browser engine (~75 MB), one moment..."
curl -fL --progress-bar \
  "https://github.com/electron/electron/releases/download/v${ELECTRON_VER}/${EZIP}" \
  -o electron.zip || die "Download failed. Check your internet connection and try again."

say "Checking the download is genuine..."
GOT=$(shasum -a 256 electron.zip | awk '{print $1}')
[ "$GOT" = "$WANT" ] || die "The download didn't verify (checksum mismatch). Try again."

say "Unpacking..."
mkdir engine && unzip -q electron.zip -d engine

APP="$WORK/Orchard.app"
cp -R "engine/Electron.app" "$APP"
C="$APP/Contents"

# --- rename the executable and brand the app --------------------------------
mv "$C/MacOS/Electron" "$C/MacOS/Orchard"
rm -f "$C/Resources/default_app.asar" "$C/Resources/electron.icns"

PB=/usr/libexec/PlistBuddy
PL="$C/Info.plist"
$PB -c "Set :CFBundleExecutable Orchard"        "$PL"
$PB -c "Set :CFBundleName Orchard"              "$PL"
$PB -c "Set :CFBundleDisplayName Orchard"       "$PL"
$PB -c "Set :CFBundleIdentifier com.orchard.browser" "$PL"
$PB -c "Set :CFBundleIconFile orchard.icns"     "$PL"
$PB -c "Delete :ElectronAsarIntegrity"          "$PL" 2>/dev/null || true

# --- fetch Orchard's own files ----------------------------------------------
say "Getting Orchard..."
mkdir -p "$C/Resources/app"
curl -fsSL "$REPO/orchard.icns" -o "$C/Resources/orchard.icns" || die "Could not fetch the icon."

# the file list comes from version.json so this installer never goes stale
curl -fsSL "$REPO/version.json" -o version.json || die "Could not reach the Orchard update server."
FILES=$(grep '"path"' version.json | sed -E 's/.*"path": *"([^"]+)".*/\1/')
[ -n "$FILES" ] || die "The update server returned no files."
for f in $FILES; do
  mkdir -p "$C/Resources/app/$(dirname "$f")"
  curl -fsSL "$REPO/app/$f" -o "$C/Resources/app/$f" || die "Could not download $f."
done

# --- sign so macOS will run it (ad-hoc; no Apple account needed) -------------
say "Signing the app for your Mac..."
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" 2>/dev/null \
  || die "Signing failed. If macOS asks to install 'command line developer tools', click Install, then run this again."

# --- install into /Applications (fall back to ~/Applications) ----------------
DEST="/Applications"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
rm -rf "$DEST/Orchard.app"
cp -R "$APP" "$DEST/Orchard.app"
xattr -cr "$DEST/Orchard.app" 2>/dev/null || true

say "Done! Opening Orchard..."
open "$DEST/Orchard.app" || true
echo
echo "Orchard is now in your $DEST folder."
echo "You can close this window."
