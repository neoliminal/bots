#!/bin/sh
# Bots personal-host provisioning. Idempotent: run as often as you like.
#
# Usage: copy the host/ directory to the machine, then:  ./provision.sh
#
# What it does (and nothing else):
#   - verifies node >= 20 is installed
#   - installs the browse runtime (playwright + chromium) into this directory
#   - creates ~/.bots-host/{workspace,profile}, owner-only (0700)
#   - copies browse.mjs AND its node_modules into ~/.bots-host so the app can
#     invoke it at a stable path over SSH
# It does NOT open any network port: the browse daemon binds 127.0.0.1 only,
# and the app reaches this machine exclusively through your existing sshd.
set -eu

# Everything we create here is private to you: the profile directory holds
# real login cookies, and the daemon token is a capability to drive them.
umask 077

ROOT="${BOTS_HOST_ROOT:-$HOME/.bots-host}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== Bots personal host provisioning =="

# 0. Refuse to install from a world-writable directory. Anyone on the box
#    could have edited these files (or slipped a module into node_modules)
#    between the copy and this run, and we are about to execute them as you.
if [ -n "$(find "$HERE" -maxdepth 0 -perm -002 2>/dev/null)" ]; then
  echo "ERROR: $HERE is world-writable — move this directory somewhere only" >&2
  echo "       you can write (e.g. ~/bots-host-setup) and re-run." >&2
  exit 1
fi

# 1. Node version check.
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Install Node.js 20+ and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: node >= 20 required (found $(node --version))." >&2
  exit 1
fi
echo "node $(node --version) ok"

# 2. Install the browse runtime next to this script.
echo "Installing browse runtime (playwright)…"
(cd "$HERE" && npm install --no-audit --no-fund --loglevel=error)
echo "Installing Chromium for playwright…"
(cd "$HERE" && npx --yes playwright install chromium)

# 3. Directory layout, owner-only. The chmods run every time so existing
#    installs created under a laxer umask get tightened on the next run.
mkdir -p "$ROOT/workspace" "$ROOT/profile"
chmod 700 "$ROOT" "$ROOT/workspace" "$ROOT/profile"
echo "Layout ready: $ROOT/{workspace,profile} (0700)"

# 4. Stop any daemon still running the previous browse.mjs, so the new code
#    (and its auth token) takes effect on the next browse call.
pkill -f "$ROOT/browse.mjs serve" 2>/dev/null || true

# 5. Stable entrypoint for the app: ~/.bots-host/browse.mjs plus its own
#    copy of the dependency tree.
#
#    We COPY node_modules rather than symlinking it. A symlink would bind the
#    daemon's dependencies to wherever this setup directory happened to be
#    unpacked, forever — and if that is a shared location such as /tmp, any
#    local user could later drop a file into the tree and get code execution
#    as you the next time the daemon starts. Inside $ROOT (0700) the copy is
#    only writable by you. Re-running provision.sh refreshes it.
cp "$HERE/browse.mjs" "$ROOT/browse.mjs"
chmod 600 "$ROOT/browse.mjs"
rm -rf "$ROOT/node_modules.tmp"
cp -R "$HERE/node_modules" "$ROOT/node_modules.tmp"
rm -rf "$ROOT/node_modules"          # also removes the symlink older installs left
mv "$ROOT/node_modules.tmp" "$ROOT/node_modules"
echo "Entrypoint installed: $ROOT/browse.mjs"

# 6. Friendly summary.
echo ""
echo "== Done =="
echo "Host root:        $ROOT (0700)"
echo "Per-bot work in:  $ROOT/workspace/<botId>"
echo "Browser profile:  $ROOT/profile (persistent — logins survive)"
echo "Daemon token:     $ROOT/daemon-token (created on first browse call, 0600)"
echo ""
echo "To sign every bot out of a site later:"
echo "  node $ROOT/browse.mjs --clear github.com    # or --clear for all sites"
echo ""
echo "Next steps on your Mac:"
echo "  1. Ensure you can:  ssh $(whoami)@$(hostname) 'echo ok'   (key-based, no password prompt)"
echo "  2. In Bots → Settings → Sessions, choose 'Personal host' and enter:  $(whoami)@$(hostname)"
