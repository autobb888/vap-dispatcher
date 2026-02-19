#!/bin/bash
#
# Build pre-baked VAP Job Agent Docker image (using pnpm)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCHER_DIR="$(dirname "$SCRIPT_DIR")"
VAP_SDK_DIR="${DISPATCHER_DIR}/vap-agent-sdk"

IMAGE_NAME="${VAP_JOB_IMAGE:-vap/job-agent}"
IMAGE_TAG="${VAP_JOB_TAG:-latest}"

echo "╔══════════════════════════════════════════╗"
echo "║     Build VAP Job Agent Image            ║"
echo "║     (using pnpm)                         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Image: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""

# Check dependencies
echo "→ Checking dependencies..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker required"
    exit 1
fi

if ! command -v pnpm &> /dev/null; then
    echo "→ Installing pnpm..."
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    export PATH="$HOME/.local/share/pnpm:$PATH"
fi

echo "✓ Using pnpm: $(pnpm --version)"

# Ensure SDK is built
echo ""
echo "→ Ensuring SDK is built..."
cd "$VAP_SDK_DIR"
if [ ! -d "node_modules" ]; then
    pnpm install
fi
if [ ! -f "dist/index.js" ]; then
    pnpm build || npx tsc
fi
cd "$DISPATCHER_DIR"
echo "✓ SDK ready"

# Build the image
echo ""
echo "→ Building Docker image..."

# Copy SDK into build context (Docker can't access parent dirs)
echo "→ Copying files to build context..."
rm -rf .build-temp 2>/dev/null || true
mkdir -p .build-temp/vap-agent-sdk

# Copy SDK files
cp "$VAP_SDK_DIR/package.json" .build-temp/vap-agent-sdk/
cp -r "$VAP_SDK_DIR/dist" .build-temp/vap-agent-sdk/
cp -r "$VAP_SDK_DIR/scripts" .build-temp/vap-agent-sdk/
cp -r "$VAP_SDK_DIR/bin" .build-temp/vap-agent-sdk/
if [ -d "$VAP_SDK_DIR/node_modules" ]; then
  cp -r "$VAP_SDK_DIR/node_modules" .build-temp/vap-agent-sdk/
fi

# Copy dispatcher files needed by Dockerfile
cp "$DISPATCHER_DIR/package.docker.json" .build-temp/package.json
cp -r "$DISPATCHER_DIR/src" .build-temp/
cp "$DISPATCHER_DIR/Dockerfile.job-agent" .build-temp/Dockerfile

# Build
docker build \
    -f .build-temp/Dockerfile \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    .build-temp

# Cleanup
rm -rf .build-temp

echo ""
echo "✅ Image built: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "Size:"
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}"
echo ""
echo "Test run:"
echo "  docker run --rm ${IMAGE_NAME}:${IMAGE_TAG} --help"
