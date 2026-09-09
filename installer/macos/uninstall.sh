#!/usr/bin/env bash
# Remove the QC Portal install (macOS / Linux). Mirrors what install.sh created —
# nothing more:
#
#   ~/.qc-portal                    the checkout, WITH the run history in data/
#   ~/.local/bin/qc-portal          the shim
#   ~/Applications/QC Portal.app    the launcher (macOS)
#
# Node, git and Claude Code are left alone: other things use them. So are the
# `export PATH=...` lines install.sh appended to your shell rc files — they are
# harmless, and editing someone's rc file to remove one line is worse than leaving it.
#
#   bash installer/macos/uninstall.sh
set -euo pipefail

INSTALL_DIR="${QC_PORTAL_HOME:-$HOME/.qc-portal}"
SHIM="$HOME/.local/bin/qc-portal"
APP="$HOME/Applications/QC Portal.app"
DATA="$INSTALL_DIR/data"

printf 'QC Portal uninstaller\n'
[ -d "$INSTALL_DIR" ] && printf '  install: %s\n' "$INSTALL_DIR" || printf '  nothing at %s — already gone.\n' "$INSTALL_DIR"
if [ -d "$DATA" ]; then
  printf '\033[33m  data:    %s  (%s — projects, run history, screenshots)\033[0m\n' "$DATA" "$(du -sh "$DATA" 2>/dev/null | cut -f1)"
  printf '\033[33m           Copy it elsewhere first if you want to keep any of that.\033[0m\n'
fi

printf '\nType YES to remove QC Portal: '
read -r answer
[ "$answer" = 'YES' ] || { printf '  cancelled — nothing was deleted.\n'; exit 0; }

# Stop the server first, so nothing is writing into the folder as it goes.
[ -f "$INSTALL_DIR/bin/qc-portal.mjs" ] && node "$INSTALL_DIR/bin/qc-portal.mjs" --stop >/dev/null 2>&1 || true

[ -e "$APP" ]  && { rm -rf "$APP";  printf '  removed %s\n' "$APP"; }
[ -e "$SHIM" ] && { rm -f  "$SHIM"; printf '  removed %s\n' "$SHIM"; }
[ -d "$INSTALL_DIR" ] && { rm -rf "$INSTALL_DIR"; printf '  removed %s\n' "$INSTALL_DIR"; }
printf '\033[32m\nDone. Node, git and Claude Code were left alone.\033[0m\n'
