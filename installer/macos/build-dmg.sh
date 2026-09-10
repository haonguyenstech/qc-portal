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
# NOT notarised, and on macOS 15 (Sequoia) and later that means a double-click is
# simply REFUSED: "Apple could not verify ... is free of malware", with Move to Trash
# as the default button. The old right-click -> Open bypass NO LONGER EXISTS - Apple
# removed it, so any instruction that still says it is wrong.
#
# What does work is running the script through an interpreter: the notarization check
# lives in LaunchServices (a Finder double-click), not in the shell. So READ ME
# FIRST.txt leads with `bash ` + DRAG THE FILE IN, which needs no settings change at
# all -- and is deliberately not a hardcoded /Volumes path, because a second copy of
# this image mounts as "<name> 1" and every typed path would then be wrong. The GUI
# route (System Settings -> Privacy & Security -> Open Anyway) is offered second.
#
# Notarising, which would restore the double-click, needs a paid Apple Developer ID;
# see docs/architecture/installer.md.
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
# A double-click on this file is REFUSED by macOS 15+ (this image is not notarised).
# Run it from Terminal instead - see READ ME FIRST.txt in the same window.
set -euo pipefail
printf '\033[1mQC Portal installer\033[0m\n\n'
curl -fsSL '$RAW' | bash
printf '\nPress any key to close.\n'
read -r -n 1 -s
CMD
chmod +x "$STAGE/Install QC Portal.command"

# A README the user sees next to it in the mounted window, because the right-click
# dance is not discoverable and a failed double-click looks like a broken download.
cat > "$STAGE/READ ME FIRST.txt" <<TXT
QC Portal - install
===================

macOS will NOT let you double-click the installer. This disk image is not signed
by Apple, and since macOS 15 an unsigned download is refused outright ("Apple
could not verify..."). That is expected, and the file is fine. Do this instead.


EASIEST - run it from Terminal (nothing to confirm, no settings to change)
-------------------------------------------------------------------------

1. Open Terminal: press Command-Space, type Terminal, press Return.
2. Type these five characters, INCLUDING the space at the end:

       bash 

3. DRAG "Install QC Portal.command" from this window into the Terminal window.
   Terminal fills in the path for you.
4. Press Return.

The block applies to opening the file from Finder, not to running it in a shell.

(Typing the path by hand works too, but only while this is the only copy of
the image you have open: macOS mounts a second one under a different name, and
a typed path is then wrong. Dragging is always right.)


DON'T WANT THE DISK IMAGE AT ALL?
---------------------------------

This one line does exactly the same thing, with nothing to download first:

    curl -fsSL $RAW | bash


IF YOU PREFER CLICKING
----------------------

1. Double-click "Install QC Portal.command", then press Done on the warning.
2. Open System Settings > Privacy & Security and scroll to Security.
3. Next to "Install QC Portal.command was blocked", click Open Anyway.
4. Double-click the file again and confirm.


WHAT HAPPENS NEXT
-----------------

A Terminal window works for a few minutes: it installs Node, Git and Claude Code
if they are missing, downloads the portal and builds it. Leave it alone until it
says Done.

You get a "QC Portal" app in Launchpad - click it and the portal opens in its own
window - plus a \`qc-portal\` command in a new terminal (--stop, --status, --update).

One thing stays yours to do: sign in to Claude once. Either run \`claude\` in a
terminal, or use Auto Agent AI > Connect in the portal's sidebar.

Requires an internet connection.
TXT

[ -f "$ROOT/installer/icons/qc-portal.icns" ] && cp "$ROOT/installer/icons/qc-portal.icns" "$STAGE/.VolumeIcon.icns"

rm -f "$DMG"
# UDZO = compressed read-only, the normal shape for a download.
hdiutil create -quiet -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
printf 'built %s (%s)\n' "$DMG" "$(du -h "$DMG" | cut -f1)"
