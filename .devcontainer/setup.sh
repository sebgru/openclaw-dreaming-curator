#!/usr/bin/env bash
# .devcontainer/setup.sh — runs once inside the container after creation.
# Safe to re-run; all steps are idempotent.
set -euo pipefail

# ── System packages ───────────────────────────────────────────────────────────
echo "→ Installing system packages (vim, jq)…"
sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends vim jq

# ── Node dev tools ────────────────────────────────────────────────────────────
# Install the same tools used elsewhere so local and CI environments match.
# This repository has dev dependencies but no runtime dependencies.
echo "→ Installing project dependencies…"
cd /workspace
if node -e "const p=require('./package.json'); process.exit((p.dependencies||p.devDependencies) ? 0 : 1)"; then
    npm install
else
    echo "  No dependencies declared in package.json — skipping npm install."
fi

echo "→ Installing standalone dev tools…"
npm install --global eslint@9 prettier@3

# ── Host credentials ──────────────────────────────────────────────────────────
# Host config (~/.gitconfig, ~/.ssh, ~/.config/gh) is bind-mounted directly into
# the container user's home, so the host's `git` and `gh` logins are reused
# as-is — no copy step and no re-authentication. A bind mount keeps the host
# uid, which usually differs from the container user, so grant the container
# user ownership of the mounted paths (otherwise a 0600 hosts.yml/key is
# unreadable and gh/ssh fail).
echo "→ Fixing ownership of mounted host config…"
for path in "$HOME/.gitconfig" "$HOME/.ssh" "$HOME/.config/gh"; do
    if [ -e "$path" ]; then
        sudo chown -R "$(id -u):$(id -g)" "$path"
    fi
done

echo ""
echo "✅ Container setup complete."
echo "   Workspace : /workspace"
echo "   Node      : $(node --version)"
echo "   npm       : $(npm --version)"
echo "   eslint    : $(eslint --version 2>&1 | head -1)"
echo "   prettier  : $(prettier --version 2>&1 | head -1)"
echo "   gh        : $(gh --version 2>&1 | head -1)"
echo "   gh auth   : $(gh auth status 2>&1 | head -1 || true)"
