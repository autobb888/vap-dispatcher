#!/bin/bash
#
# VAP Dispatcher Installer
# One-line setup: curl -fsSL https://.../install.sh | bash
#

set -e

VAP_VERSION="0.2.0"
INSTALL_DIR="${HOME}/.vap/dispatcher"
REPO_URL="https://github.com/autobb888/vap-dispatcher"

echo "╔══════════════════════════════════════════╗"
echo "║     VAP Dispatcher Installer             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check dependencies
echo "→ Checking dependencies..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker is required but not installed"
    echo "   Install: https://docs.docker.com/get-docker/"
    exit 1
fi
echo "✓ Docker found"

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed"
    echo "   Install: https://nodejs.org/"
    exit 1
fi
echo "✓ Node.js found"

# Install pnpm if missing
if ! command -v pnpm &> /dev/null; then
    echo "→ Installing pnpm..."
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    export PATH="$HOME/.local/share/pnpm:$PATH"
fi
echo "✓ pnpm found"

# Create directories
echo ""
echo "→ Creating directories..."
mkdir -p "$INSTALL_DIR"

# Clone or update dispatcher
echo ""
echo "→ Installing dispatcher..."

if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    git pull
    git submodule update --init
else
    git clone --recurse-submodules "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || {
        echo "⚠️  Clone failed, trying release download"
        curl -fsSL "$REPO_URL/releases/download/v${VAP_VERSION}/vap-dispatcher-${VAP_VERSION}.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null || {
            echo "❌ Could not install dispatcher"
            exit 1
        }
    }
fi

# Install dependencies
cd "$INSTALL_DIR"
pnpm install

# Build SDK
cd "$INSTALL_DIR/vap-agent-sdk"
npm install && npm run build
cd "$INSTALL_DIR"

# Create symlink
echo ""
echo "→ Creating command shortcut..."
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/src/cli-v2.js" "$HOME/.local/bin/vap-dispatcher"
chmod +x "$INSTALL_DIR/src/cli-v2.js"

# Add to PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    echo "✓ Added ~/.local/bin to PATH (restart terminal to use)"
fi

# Final message
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Installation Complete!               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Ensure ~/.local/bin is in your PATH"
echo "  2. Initialize agents: vap-dispatcher init -n 9"
echo "  3. Register agents:   vap-dispatcher register agent-1 ari1"
echo "  4. Start dispatcher:  vap-dispatcher start"
echo ""
