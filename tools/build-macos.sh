#!/bin/bash
# Builds the macOS apps with the Swift command-line tools (Xcode is not needed):
#   dist/Headroom Server.app   menu-bar app + engine (the `headroom` CLI lives in Contents/MacOS)
#   dist/Headroom Viewer.app   viewer
#
#   tools/build-macos.sh [--only server|viewer] [--universal] [--debug]
#
# Signing: ad-hoc by default. macOS ties Screen Recording / Accessibility grants to the code signature, and an
# ad-hoc signature changes with every build — so after rebuilding, macOS asks again. For a stable identity set
# HEADROOM_SIGN_IDENTITY to a code-signing certificate's name (a "Developer ID Application: …" certificate, or a
# self-signed one created in Keychain Access → Certificate Assistant → Create a Certificate… → Code Signing).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${HEADROOM_VERSION:-0.1.0}"
BUILD_NUMBER="${HEADROOM_BUILD:-$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)}"
ONLY=""
UNIVERSAL=0
CONFIG=release
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --universal) UNIVERSAL=1; shift ;;
    --debug) CONFIG=debug; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v swift >/dev/null || { echo "Swift is required: xcode-select --install" >&2; exit 1; }
DIST="$ROOT/dist"
mkdir -p "$DIST"
ICON="$ROOT/assets/macos/AppIcon.icns"
[ -f "$ICON" ] || python3 "$ROOT/tools/make_icons.py" --macos

# Builds products of a package; echoes the directory holding the binaries (lipo'd for --universal).
build() {
  local pkg="$1"; shift
  local products=("$@")
  if [ "$UNIVERSAL" = 1 ]; then
    local out="$ROOT/$pkg/.build/universal-$CONFIG"
    mkdir -p "$out"
    for arch in arm64 x86_64; do
      for p in "${products[@]}"; do
        swift build --package-path "$ROOT/$pkg" -c "$CONFIG" --arch "$arch" --product "$p" >&2
      done
    done
    for p in "${products[@]}"; do
      lipo -create -output "$out/$p" \
        "$(swift build --package-path "$ROOT/$pkg" -c "$CONFIG" --arch arm64 --show-bin-path)/$p" \
        "$(swift build --package-path "$ROOT/$pkg" -c "$CONFIG" --arch x86_64 --show-bin-path)/$p"
    done
    echo "$out"
  else
    for p in "${products[@]}"; do
      swift build --package-path "$ROOT/$pkg" -c "$CONFIG" --product "$p" >&2
    done
    swift build --package-path "$ROOT/$pkg" -c "$CONFIG" --show-bin-path
  fi
}

plist() { # file, then key/value pairs (values starting with ! are raw plist)
  local f="$1"; shift
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    while [ $# -gt 0 ]; do
      echo "  <key>$1</key>"
      case "$2" in
        '!'*) echo "  ${2:1}" ;;
        *) echo "  <string>$2</string>" ;;
      esac
      shift 2
    done
    echo '</dict></plist>'
  } > "$f"
  plutil -lint "$f" >/dev/null
}

sign() { # path...
  local id="${HEADROOM_SIGN_IDENTITY:--}"
  local opts=(--force --timestamp=none --sign "$id")
  [ "$id" != "-" ] && opts=(--force --options runtime --timestamp --sign "$id")
  codesign "${opts[@]}" "$@"
}

if [ "$ONLY" != "viewer" ]; then
  echo "==> Headroom Server"
  BIN="$(build host-macos headroom HeadroomServer)"
  APP="$DIST/Headroom Server.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$BIN/HeadroomServer" "$BIN/headroom" "$APP/Contents/MacOS/"
  cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
  # The web client the engine serves to viewers (and the settings page).
  rsync -a --delete --exclude '.DS_Store' "$ROOT/web/" "$APP/Contents/Resources/web/"
  plist "$APP/Contents/Info.plist" \
    CFBundleIdentifier app.headroom.server \
    CFBundleName "Headroom Server" \
    CFBundleDisplayName "Headroom Server" \
    CFBundleExecutable HeadroomServer \
    CFBundleIconFile AppIcon \
    CFBundlePackageType APPL \
    CFBundleShortVersionString "$VERSION" \
    CFBundleVersion "$BUILD_NUMBER" \
    CFBundleInfoDictionaryVersion 6.0 \
    LSMinimumSystemVersion 13.0 \
    LSApplicationCategoryType public.app-category.utilities \
    LSUIElement '!<true/>' \
    NSHighResolutionCapable '!<true/>' \
    NSPrincipalClass NSApplication \
    NSLocalNetworkUsageDescription "Headroom Server checks in with your Headroom account server when it's on this network." \
    NSHumanReadableCopyright "Headroom — self-hosted remote desktop"
  xattr -cr "$APP"
  sign "$APP/Contents/MacOS/headroom"
  sign "$APP"
  codesign --verify --strict "$APP"
  echo "    $APP"
fi

if [ "$ONLY" != "server" ]; then
  echo "==> Headroom Viewer"
  BIN="$(build viewer-macos HeadroomViewer)"
  APP="$DIST/Headroom Viewer.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$BIN/HeadroomViewer" "$APP/Contents/MacOS/"
  cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
  # The same web client the hosts serve, bundled so the viewer works on its own (minus the host settings page).
  rsync -a --delete --exclude '.DS_Store' --exclude 'admin.html' --exclude 'js/admin.js' --exclude 'css/admin.css' \
    "$ROOT/web/" "$APP/Contents/Resources/client/"
  plist "$APP/Contents/Info.plist" \
    CFBundleIdentifier app.headroom.viewer \
    CFBundleName "Headroom Viewer" \
    CFBundleDisplayName "Headroom Viewer" \
    CFBundleExecutable HeadroomViewer \
    CFBundleIconFile AppIcon \
    CFBundlePackageType APPL \
    CFBundleShortVersionString "$VERSION" \
    CFBundleVersion "$BUILD_NUMBER" \
    CFBundleInfoDictionaryVersion 6.0 \
    LSMinimumSystemVersion 13.0 \
    LSApplicationCategoryType public.app-category.utilities \
    NSHighResolutionCapable '!<true/>' \
    NSPrincipalClass NSApplication \
    NSLocalNetworkUsageDescription "Headroom Viewer connects to your computers on this network." \
    NSHumanReadableCopyright "Headroom — self-hosted remote desktop"
  xattr -cr "$APP"
  sign "$APP"
  codesign --verify --strict "$APP"
  echo "    $APP"
fi

echo
echo "Install: tools/install-macos.sh   (copies to /Applications and starts Headroom Server)"
