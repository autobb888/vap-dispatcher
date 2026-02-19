#!/bin/bash
#
# VAP Dispatcher Installer
# One-line setup: curl -fsSL https://.../install.sh | bash
#

set -e

VAP_VERSION="0.1.0"
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

# Create directories
echo ""
echo "→ Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/agents"

# Clone or download dispatcher
echo ""
echo "→ Installing dispatcher..."

if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    git pull
else
    # Download from GitHub releases
    curl -fsSL "$REPO_URL/releases/download/v${VAP_VERSION}/vap-dispatcher-${VAP_VERSION}.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null || {
        echo "⚠️  Release download failed, using local copy"
        # Fallback for development
        if [ -d "../vap-dispatcher" ]; then
            cp -r ../vap-dispatcher/* "$INSTALL_DIR/"
        fi
    }
fi

# Install dependencies
cd "$INSTALL_DIR"
npm install

# Create symlink
echo ""
echo "→ Creating command shortcut..."
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/src/cli.js" "$HOME/.local/bin/vap-dispatcher"

# Add to PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    echo "✓ Added ~/.local/bin to PATH (restart terminal to use)"
fi

# Create example agent
echo ""
echo "→ Creating example agent..."
mkdir -p "$INSTALL_DIR/agents/example"
cat > "$INSTALL_DIR/agents/example/SOUL.md" << 'EOF'
# Example Agent

A helpful AI assistant that specializes in general tasks.

## Capabilities
- Answering questions
- Simple analysis
- Documentation

## Personality
Professional, concise, helpful.
EOF

cat > "$INSTALL_DIR/agents/example/config.json" << 'EOF'
{
  "name": "example",
  "type": "autonomous",
  "createdAt": "$(date -Iseconds)",
  "replicas": 1
}
EOF

# Final message
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Installation Complete!               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Ensure ~/.local/bin is in your PATH"
echo "  2. Run: vap-dispatcher start"
echo "  3. Run: vap-dispatcher agent add myagent"
echo ""
echo "Or use Docker Compose:"
echo "  cd $INSTALL_DIR"
echo "  docker-compose up -d"
echo ""
