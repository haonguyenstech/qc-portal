#!/usr/bin/env bash
# QC Portal installer — macOS / Linux / WSL / Git Bash
#
#   curl -fsSL https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.sh | bash
#
# Ensures git, Node 22.5+, and Claude Code are present, clones (or updates) the
# repo into ~/.qc-portal, builds it, and adds a `qc-portal` command to your PATH.
set -euo pipefail

REPO="https://github.com/haonguyenstech/qc-portal.git"
RAW_BRANCH="main"
INSTALL_DIR="${QC_PORTAL_HOME:-$HOME/.qc-portal}"
BIN_DIR="$HOME/.local/bin"
NODE_FALLBACK_VERSION="v22.12.0"   # used only if we must download Node ourselves

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
die()  { printf '\033[31m  x %s\033[0m\n' "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- Node ------------------------------------------------------------------
node_ok() {
  have node || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a>22||(a===22&&b>=5))?0:1)' 2>/dev/null
}

install_node_tarball() {
  local os arch ver url tmp
  ver="$NODE_FALLBACK_VERSION"
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    *) die "Unsupported OS for automatic Node install — install Node ${ver}+ manually." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "Unsupported CPU for automatic Node install — install Node manually." ;;
  esac
  url="https://nodejs.org/dist/${ver}/node-${ver}-${os}-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  info "Downloading Node ${ver} (${os}-${arch})…"
  curl -fsSL "$url" -o "$tmp/node.tar.gz" || die "Failed to download Node from $url"
  mkdir -p "$INSTALL_DIR/runtime"
  rm -rf "$INSTALL_DIR/runtime/node"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  mv "$tmp/node-${ver}-${os}-${arch}" "$INSTALL_DIR/runtime/node"
  rm -rf "$tmp"
  export PATH="$INSTALL_DIR/runtime/node/bin:$PATH"
  RUNTIME_NODE_BIN="$INSTALL_DIR/runtime/node/bin"
}

ensure_node() {
  if node_ok; then info "Node $(node -v) ✓"; return; fi
  bold "Installing Node.js (22.5+ required)…"
  if have brew; then
    brew install node || true
  fi
  if ! node_ok && have apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1 || true
    sudo apt-get install -y nodejs >/dev/null 2>&1 || true
  fi
  if ! node_ok; then
    install_node_tarball
  fi
  node_ok || die "Could not install a suitable Node.js. Install Node 22.5+ and re-run."
  info "Node $(node -v) ✓"
}

# --- Claude Code -----------------------------------------------------------
ensure_claude() {
  if have claude; then info "Claude Code ✓"; return; fi
  bold "Installing Claude Code…"
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 \
    || warn "Could not auto-install Claude Code. Install it from https://claude.com/claude-code and ensure \`claude\` is on PATH."
  have claude && info "Claude Code ✓"
}

# --- Source ----------------------------------------------------------------
fetch_source() {
  have git || die "git is required. Install git and re-run."
  if [ -d "$INSTALL_DIR/.git" ]; then
    bold "Updating existing install at $INSTALL_DIR…"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    bold "Cloning into $INSTALL_DIR…"
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
}

build() {
  bold "Installing dependencies & building (this takes a minute)…"
  ( cd "$INSTALL_DIR" && npm install && npm run build )
}

# --- PATH shim -------------------------------------------------------------
RUNTIME_NODE_BIN=""
install_shim() {
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/qc-portal" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/bin/qc-portal.mjs" "\$@"
EOF
  chmod +x "$BIN_DIR/qc-portal"

  # Make sure ~/.local/bin (and any downloaded Node) is on PATH in the user's shell.
  local rc line_bin line_node
  line_bin='export PATH="$HOME/.local/bin:$PATH"'
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -e "$rc" ] || continue
    grep -qF "$line_bin" "$rc" 2>/dev/null || printf '\n# Added by QC Portal installer\n%s\n' "$line_bin" >> "$rc"
    if [ -n "$RUNTIME_NODE_BIN" ]; then
      line_node="export PATH=\"$RUNTIME_NODE_BIN:\$PATH\""
      grep -qF "$line_node" "$rc" 2>/dev/null || printf '%s\n' "$line_node" >> "$rc"
    fi
  done
  export PATH="$BIN_DIR:$PATH"
}

main() {
  bold "QC Portal installer"
  ensure_node
  ensure_claude
  fetch_source
  build
  install_shim
  echo
  bold "Done! 🎉"
  info "Open a new terminal (so PATH refreshes), then run:"
  echo
  printf '    \033[1mqc-portal\033[0m            # start the portal and open it in your browser\n'
  printf '    \033[1mqc-portal --stop\033[0m     # stop it\n'
  printf '    \033[1mqc-portal --update\033[0m   # update to the latest version\n'
  echo
}
main "$@"
