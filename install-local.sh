#!/bin/bash

# Uninstall the globally installed pi package and install from this local repo

set -e

echo "Uninstalling global @mariozechner/pi-coding-agent..."
npm uninstall -g @mariozechner/pi-coding-agent 2>/dev/null || true

echo "Building packages..."
npm run build

echo "Installing local pi-coding-agent globally..."
npm install -g ./packages/coding-agent

echo "Installing extensions to ~/.pi/agent/extensions/..."
mkdir -p ~/.pi/agent/extensions
cp ./packages/coding-agent/examples/extensions/ralph-wiggum.ts ~/.pi/agent/extensions/
cp ./packages/coding-agent/examples/extensions/handoff.ts ~/.pi/agent/extensions/
cp ./packages/coding-agent/examples/extensions/checkpoint.ts ~/.pi/agent/extensions/

echo "Done! Installed pi from local repo:"
which pi
pi --version
echo ""
echo "Extensions installed:"
ls -la ~/.pi/agent/extensions/*.ts 2>/dev/null || echo "  (none)"
