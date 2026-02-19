#!/bin/bash
#
# One-Shot VAP Dispatcher Setup
# Does EVERYTHING in one command
#

set -e

cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║     VAP Dispatcher Full Setup            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────
# STEP 1: Get SDK
# ─────────────────────────────────────────
echo "→ Step 1/5: Getting SDK..."

if [ ! -d "vap-agent-sdk" ]; then
    echo "  Cloning vap-agent-sdk..."
    git clone https://github.com/autobb888/vap-agent-sdk.git
fi

# Ensure SDK has node_modules
if [ ! -d "vap-agent-sdk/node_modules" ]; then
    echo "  Installing SDK dependencies..."
    cd vap-agent-sdk
    npm install
    cd ..
fi

# Ensure SDK has dist (compile if needed)
if [ ! -f "vap-agent-sdk/dist/index.js" ]; then
    echo "  Building SDK..."
    cd vap-agent-sdk
    npm run build 2>/dev/null || {
        echo "  ⚠️  TypeScript build had errors, checking..."
        # Check if dist was created anyway
        if [ ! -f "dist/index.js" ]; then
            echo "  ❌ SDK build failed. Trying fallback..."
            # Copy src to dist as fallback (Node can run JS directly)
            cp -r src dist 2>/dev/null || true
        fi
    }
    cd ..
fi

if [ ! -f "vap-agent-sdk/dist/index.js" ]; then
    echo "  ❌ SDK dist not found. Please check SDK setup."
    exit 1
fi

echo "  ✓ SDK ready"

# ─────────────────────────────────────────
# STEP 2: Install dispatcher deps
# ─────────────────────────────────────────
echo ""
echo "→ Step 2/5: Installing dispatcher dependencies..."

npm install

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
echo "   node src/cli-v2.js register agent-1 ari1"
echo "   node src/cli-v2.js register agent-2 ari2"
echo "   ... (repeat for all 9)"
echo ""
echo "2. Wait for confirmations (~5-15 min each)"
echo ""
echo "3. Start dispatcher:"
echo "   node src/cli-v2.js start"
echo ""
echo "4. Post jobs from dashboard and watch!"
echo ""
