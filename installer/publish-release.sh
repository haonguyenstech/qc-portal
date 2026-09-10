#!/usr/bin/env bash
# Publish the desktop installers for the version in package.json.
#
#   bash installer/publish-release.sh              # build, then upload to the tag
#   QC_DRY_RUN=1 bash installer/publish-release.sh # build and print, upload nothing
#
# Run it AFTER the release commit and tag are pushed (see "Releasing" in CLAUDE.md).
#
# EACH ARTEFACT IS UPLOADED TWICE, under two names, and both are load-bearing:
#
#   QC-Portal-Setup-<version>.exe      the one to hand to a person. The filename says
#   QC-Portal-Installer-<version>.dmg  which version it is, which matters the moment
#                                      two of them are sitting in someone's Downloads.
#
#   QC-Portal-Setup.exe                the one the README's download buttons point at,
#   QC-Portal-Installer.dmg            through the version-INDEPENDENT URL
#                                      releases/latest/download/<name>. GitHub resolves
#                                      that by EXACT filename, so this pair must never
#                                      gain a version suffix: rename it and every
#                                      published link breaks silently.
#
# The .dmg is built here. The .exe CANNOT be: Inno Setup only runs on Windows, so it has
# to be compiled there and copied into installer/windows/dist/ first -- this script tells
# you how if it is missing rather than publishing half a release.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="$(node -e "process.stdout.write(require('$ROOT/package.json').version)")"
TAG="v$VERSION"
EXE="$ROOT/installer/windows/dist/QC-Portal-Setup.exe"
DMG="$ROOT/installer/macos/dist/QC-Portal-Installer.dmg"
DRY="${QC_DRY_RUN:-}"

die() { printf '\033[31mx %s\033[0m\n' "$1" >&2; exit 1; }
say() { printf '  %s\n' "$1"; }

printf 'Publishing QC Portal %s\n' "$VERSION"

# The tag must exist first: the artefacts describe a released commit, not a working tree.
git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || die "tag $TAG does not exist. Commit, tag and push the release first (CLAUDE.md > Releasing)."

printf '\n== Building the .dmg\n'
bash "$HERE/macos/build-dmg.sh"

printf '\n== The .exe\n'
if [ ! -f "$EXE" ]; then
  cat >&2 <<EOF
x  $EXE is missing, and it cannot be built on macOS.

   On the Windows machine, with the release already pushed:
     winget install JRSoftware.InnoSetup
     git clone --depth 1 https://github.com/haonguyenstech/qc-portal.git %TEMP%\\qcbuild
     & "\$env:LOCALAPPDATA\\Programs\\Inno Setup 6\\ISCC.exe" %TEMP%\\qcbuild\\installer\\windows\\qc-portal.iss
   then copy dist\\QC-Portal-Setup.exe into installer/windows/dist/ here and re-run.
   (ISCC lands under %LOCALAPPDATA%\\Programs when winget has no admin rights.)
EOF
  exit 1
fi
say "found $(du -h "$EXE" | cut -f1)"

# Versioned copies live beside the stable ones; dist/ is gitignored either way.
EXE_V="$(dirname "$EXE")/QC-Portal-Setup-$VERSION.exe"
DMG_V="$(dirname "$DMG")/QC-Portal-Installer-$VERSION.dmg"
cp "$EXE" "$EXE_V"
cp "$DMG" "$DMG_V"

printf '\n== Uploading to %s\n' "$TAG"
for f in "$EXE_V" "$DMG_V" "$EXE" "$DMG"; do say "$(basename "$f")  $(du -h "$f" | cut -f1)"; done
if [ -n "$DRY" ]; then
  printf '\nQC_DRY_RUN set - nothing uploaded.\n'
  exit 0
fi
# --clobber so re-running after a rebuild replaces the asset instead of failing.
gh release upload "$TAG" "$EXE_V" "$DMG_V" "$EXE" "$DMG" --clobber \
  || die "upload failed. Does the release for $TAG exist? Create it with: gh release create $TAG"

printf '\n== Checking the buttons still resolve\n'
for f in QC-Portal-Setup.exe QC-Portal-Installer.dmg; do
  code="$(curl -sIL -o /dev/null -w '%{http_code}' "https://github.com/haonguyenstech/qc-portal/releases/latest/download/$f")"
  say "$f -> HTTP $code"
  [ "$code" = "200" ] || die "$f does not resolve through releases/latest/download - the README buttons are broken."
done
printf '\n\033[32mDone - %s published.\033[0m\n' "$VERSION"
