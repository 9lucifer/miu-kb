#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/.." && pwd)"
APP="$ROOT/dist/Miu KB.app"
EXEC="$ROOT/.build/release/MiuKbMac"
ICON="$ROOT/Assets/AppIcon.icns"

swift build --package-path "$ROOT" -c release
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$EXEC" "$APP/Contents/MacOS/MiuKbMac"
if [[ -f "$ICON" ]]; then
  cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
fi
rsync -a --delete \
  --exclude '/node_modules/' \
  --exclude '/.git/' \
  --exclude '/MiuKbMac/.build/' \
  --exclude '/MiuKbMac/dist/' \
  "$PROJECT_ROOT/" "$APP/Contents/Resources/miu-kb/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>MiuKbMac</string>
  <key>CFBundleIdentifier</key>
  <string>local.miu.kb.mac</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleName</key>
  <string>Miu KB</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
echo "$APP"
