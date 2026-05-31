#!/usr/bin/env bash
# Pitch Battle — one-command launcher.
# Starts backend (:8000), session server (:3001), frontend (:5173), and a public
# cloudflare tunnel so a phone can scan the QR and join. Ctrl-C stops everything.
#
#   ./start.sh
#
# Then open the printed PUBLIC URL + /host on the laptop and share the QR.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/tmp/micdrop"; mkdir -p "$LOG"
PIDS=()

cleanup() {
  echo; echo "⏹  shutting down…"
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  pkill -f "cloudflared tunnel --url http://localhost:5173" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# free the ports first
for port in 8000 3001 5173; do
  pid=$(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
done
sleep 1

echo "▶ backend       (:8000)…"; ( cd "$ROOT/backend"  && exec .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --log-level warning ) >"$LOG/backend.log"  2>&1 & PIDS+=($!)
echo "▶ session server(:3001)…"; ( cd "$ROOT/server"   && exec node src/index.js )                                                       >"$LOG/server.log"   2>&1 & PIDS+=($!)
echo "▶ frontend      (:5173)…"; ( cd "$ROOT/frontend" && exec npm run dev )                                                              >"$LOG/frontend.log" 2>&1 & PIDS+=($!)

printf "waiting for services"
for i in $(seq 1 60); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1 && curl -sf http://localhost:5173/ >/dev/null 2>&1; then echo " ✓"; break; fi
  printf "."; sleep 1
done

echo "▶ cloudflare tunnel…"
cloudflared tunnel --url http://localhost:5173 >"$LOG/tunnel.log" 2>&1 & PIDS+=($!)
URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE "https://[a-z0-9.-]+\.trycloudflare\.com" "$LOG/tunnel.log" | head -1)
  [ -n "$URL" ] && break; sleep 1
done

echo
echo "═══════════════════════════════════════════════════════════"
if [ -n "$URL" ]; then
  echo "  PUBLIC URL : $URL"
  echo "  Laptop host: $URL/host    ← open this & share the QR"
  echo "  Phone      : scan the QR  (or open $URL/play)"
else
  echo "  ⚠ tunnel URL not detected — see $LOG/tunnel.log"
fi
echo "  Local      : http://localhost:5173/host"
echo "  Logs       : $LOG/{backend,server,frontend,tunnel}.log"
echo "═══════════════════════════════════════════════════════════"
echo "  Ctrl-C to stop everything."
wait
