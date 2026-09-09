#!/usr/bin/env bash
# Build installer/macos/dist/QC-Portal-Installer.dmg — the macOS equivalent of the
# .exe: one file to download, open, and double-click.
#
#   bash installer/macos/build-dmg.sh
#
# The disk image holds ONE file, "Install QC Portal.command", whose whole body is
# the curl|bash line from the README. It is a delivery vehicle, not a second
# installer: the logic stays in install.sh, fetched fresh at install time, so a dmg
# handed round on a USB stick can never install a stale version of it.
#
# NOT notarised. macOS quarantines anything downloaded, and an unsigned .command
# inside it will refuse to open on a double-click — right-click -> Open, once, is
# the way through (Apple's own dialog offers it). Notarising needs a paid Apple
# Developer ID; see docs/architecture/installer.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DIST="$HERE/dist"
STAGE="$(mktemp -d)"
VOL='QC Portal Installer'
DMG="$DIST/QC-Portal-Installer.dmg"
RAW='https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.sh'

trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$DIST"
cat > "$STAGE/Install QC Portal.command" <<CMD
#!/bin/bash
# QC Portal installer. Runs the project's own install.sh, fetched fresh — so this
# file cannot go stale no matter how long the disk image has been sitting around.
#
# If macOS refuses to open this: right-click it -> Open, and confirm once. The
# image is not notarised, so Gatekeeper quarantines it on a plain double-click.
set -euo pipefail
printf '\033[1mQC Portal installer\033[0m\n\n'
curl -fsSL '$RAW' | bash
printf '\nPress any key to close.\n'
read -r -n 1 -s
CMD
chmod +x "$STAGE/Install QC Portal.command"

# A README the user sees next to it in the mounted window, because the right-click
# dance is not discoverable and a failed double-click looks like a broken download.
cat > "$STAGE/READ ME FIRST.txt" <<'TXT'
QC Portal — install
===================

1. RIGHT-CLICK "Install QC Portal.command" and choose Open.
   (A plain double-click is blocked by macOS: this image is not signed by Apple.)
2. Confirm when macOS asks.
3. Leave the Terminal window alone until it says Done — the first install takes a
   few minutes: it fetches Node, Git and Claude Code if they are missing, downloads
   the portal and builds it.

You get: a "QC Portal" app in Launchpad, and a `qc-portal` command in a new
terminal (--stop, --status, --update).

Requires an internet connection.
TXT

[ -f "$ROOT/installer/icons/qc-portal.icns" ] && cp "$ROOT/installer/icons/qc-portal.icns" "$STAGE/.VolumeIcon.icns"

rm -f "$DMG"
# UDZO = compressed read-only, the normal shape for a download.
hdiutil create -quiet -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
printf 'built %s (%s)\n' "$DMG" "$(du -h "$DMG" | cut -f1)"
