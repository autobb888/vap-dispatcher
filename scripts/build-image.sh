#!/bin/bash
#
# Build pre-baked VAP Job Agent Docker image
# This bakes all dependencies for fast container startup
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCHER_DIR="$(dirname "$SCRIPT_DIR")"

# Check for SDK in parent directory or clone it
VAP_SDK_DIR="${DISPATCHER_DIR}/../vap-agent-sdk"

if [ ! -d "$VAP_SDK_DIR" ]; then
  echo "→ SDK not found at $VAP_SDK_DIR"
  echo "→ Cloning vap-agent-sdk..."
  
  # Try to clone from GitHub
  cd "$(dirname "$DISPATCHER_DIR")"
  git clone https://github.com/autobb888/vap-agent-sdk.git 2>/dev/null || {
    echo "❌ Failed to clone SDK. Please clone manually:"
    echo "   cd $(dirname "$DISPATCHER_DIR")"
    echo "   git clone https://github.com/autobb888/vap-agent-sdk.git"
    exit 1
  }
  echo "✓ SDK cloned"
fi

IMAGE_NAME="${VAP_JOB_IMAGE:-vap/job-agent}"
IMAGE_TAG="${VAP_JOB_TAG:-latest}"

echo "╔══════════════════════════════════════════╗"
echo "║     Build VAP Job Agent Image            ║"
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

echo "✓ Dependencies OK"

# Ensure SDK is built and dependencies installed
echo ""
echo "→ Building SDK..."
cd "$VAP_SDK_DIR"
if [ ! -d "dist" ]; then
    # Use npm for SDK build (GitHub deps work better)
    npm install && npm run build
fi
# Ensure node_modules exists for copying
if [ ! -d "node_modules" ]; then
    npm install
fi
echo "✓ SDK built"

# Build the image
echo ""
echo "→ Building Docker image..."
cd "$DISPATCHER_DIR"

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
cp "$DISPATCHER_DIR/package.json" .build-temp/
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
