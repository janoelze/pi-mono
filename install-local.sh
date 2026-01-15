#!/bin/bash

# Uninstall the globally installed pi package and install from this local repo

set -e

echo "Uninstalling global @mariozechner/pi-coding-agent..."
npm uninstall -g @mariozechner/pi-coding-agent 2>/dev/null || true

echo "Building packages..."
npm run build

echo "Installing local pi-coding-agent globally..."
npm install -g ./packages/coding-agent

echo "Done! Installed pi from local repo:"
which pi
pi --version
