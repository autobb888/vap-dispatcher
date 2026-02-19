#!/bin/bash
#
# One-Shot VAP Dispatcher Setup
# Uses pnpm (NOT npm)
#

set -e

cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║     VAP Dispatcher Full Setup            ║"
echo "║     (pnpm for dispatcher, npm for SDK)   ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Install pnpm if missing
if ! command -v pnpm > /dev/null 2>&1; then
    echo "→ Installing pnpm..."
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    export PATH="$HOME/.local/share/pnpm:$PATH"
fi

echo "✓ pnpm: $(pnpm --version), npm: $(npm --version)"

# ─────────────────────────────────────────
# STEP 1: Get SDK
# ─────────────────────────────────────────
echo ""
echo "→ Step 1/5: Getting SDK..."

if [ ! -d "vap-agent-sdk" ]; then
    echo "  Cloning vap-agent-sdk..."
    git clone https://github.com/autobb888/vap-agent-sdk.git
fi

# Install SDK deps and build
# NOTE: Using npm for SDK because pnpm has issues with GitHub commit refs
cd vap-agent-sdk

# Always ensure node_modules exists
if [ ! -d "node_modules" ]; then
    echo "  Installing SDK dependencies..."
    npm install --ignore-scripts  # Skip prepare for now
fi

# Always build dist (don't rely on prepare script)
echo "  Building SDK..."
npm install -D typescript  # Ensure TypeScript is available
npx tsc --version
echo "  Running TypeScript compiler..."
npx tsc 2>&1 | head -20 || true  # Show first 20 lines of errors

# Check result
if [ ! -f "dist/index.js" ]; then
    echo "  ❌ SDK build failed - dist/index.js not found"
    echo "  Checking what was created..."
    ls -la dist/ 2>/dev/null || echo "  No dist folder"
    exit 1
fi

echo "  ✓ SDK dist created"
cd ..

if [ ! -f "vap-agent-sdk/dist/index.js" ]; then
    echo "  ❌ ERROR: SDK dist/index.js not found after build!"
    echo "  Contents of vap-agent-sdk/:"
    ls -la vap-agent-sdk/ 2>/dev/null | head -20
    exit 1
fi

echo "  ✓ SDK verified"

# ─────────────────────────────────────────
# STEP 2: Install dispatcher deps
# ─────────────────────────────────────────
echo ""
echo "→ Step 2/5: Installing dispatcher dependencies with pnpm..."

if [ ! -d "node_modules" ]; then
    pnpm install
fi

echo "  ✓ Dependencies installed"

# ─────────────────────────────────────────
# STEP 3: Build Docker image
# ─────────────────────────────────────────
echo ""
echo "→ Step 3/5: Building Docker image..."

./scripts/build-image.sh

echo "  ✓ Image built"

# ─────────────────────────────────────────
# STEP 4: Initialize agents
# ─────────────────────────────────────────
echo ""
echo "→ Step 4/5: Initializing 9 agent identities..."

node src/cli-v2.js init -n 9

echo ""
echo "  ✓ 9 agents created"
echo ""
echo "  Agent addresses (pre-funded on VRSCTEST):"
for i in {1..9}; do
    ADDR=$(cat ~/.vap/dispatcher/agents/agent-$i/keys.json 2>/dev/null | grep '"address"' | cut -d'"' -f4)
    echo "    agent-$i: $ADDR"
done

# ─────────────────────────────────────────
# STEP 5: Show next steps
# ─────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Setup Complete!                      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "1. Register agents on platform:"
echo "   pnpm cli register agent-1 ari1"
echo "   pnpm cli register agent-2 ari2"
echo "   ... (repeat for all 9)"
echo ""
echo "2. Wait for confirmations (~5-15 min each)"
echo ""
echo "3. Start dispatcher:"
echo "   pnpm start"
echo ""
echo "4. Post jobs from dashboard and watch!"
echo ""
