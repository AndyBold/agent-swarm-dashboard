#!/usr/bin/env bash
# Agent Swarm Dashboard — setup script
# Usage: bash setup.sh [--port PORT] [--serve-path PATH] [--install-dir DIR]
#
# Detects bun, installs the dashboard, registers a systemd service,
# and optionally sets up tailscale serve.

set -euo pipefail

PORT=3456
SERVE_PATH="/agents"
INSTALL_DIR="$HOME/agent-swarm-dashboard"
DB_PATH=""  # defaults to $INSTALL_DIR/data/swarm.db

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)        PORT="$2";        shift 2 ;;
    --serve-path)  SERVE_PATH="$2";  shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --db-path)     DB_PATH="$2";     shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Detect bun ───────────────────────────────────────────────────────────────
BUN_BIN=""
for candidate in "$HOME/.bun/bin/bun" "/usr/local/bin/bun" "$(which bun 2>/dev/null || true)"; do
  if [[ -x "$candidate" ]]; then
    BUN_BIN="$candidate"
    break
  fi
done
if [[ -z "$BUN_BIN" ]]; then
  echo "Error: bun not found. Install it first: https://bun.sh"
  exit 1
fi
echo "Using bun: $BUN_BIN"

# ── Install app ──────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cp -r "$SKILL_DIR/assets/src"         "$INSTALL_DIR/"
cp    "$SKILL_DIR/assets/package.json" "$INSTALL_DIR/"
cd "$INSTALL_DIR"
"$BUN_BIN" install
echo "App installed at $INSTALL_DIR"

# ── Systemd service ───────────────────────────────────────────────────────────
SERVICE_FILE="/tmp/agent-swarm.service"
[[ -z "$DB_PATH" ]] && DB_PATH="$INSTALL_DIR/data/swarm.db"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Agent Swarm Dashboard
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$BUN_BIN run src/server.ts
Restart=always
RestartSec=5
Environment=PORT=$PORT
Environment=DB_PATH=$DB_PATH

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo "Service file written to $SERVICE_FILE"
echo "Run the following to install:"
echo ""
echo "  sudo cp $SERVICE_FILE /etc/systemd/system/agent-swarm.service"
echo "  sudo systemctl daemon-reload && sudo systemctl enable --now agent-swarm"
echo "  sudo tailscale serve --bg --set-path $SERVE_PATH $PORT"
echo ""
echo "Dashboard will be available at:"
echo "  https://\$(tailscale status --json | python3 -c \"import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))\")\$SERVE_PATH"
