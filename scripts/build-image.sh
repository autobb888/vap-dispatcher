#!/bin/bash
#
# Build pre-baked VAP Job Agent Docker image
# This bakes all dependencies for fast container startup
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCHER_DIR="$(dirname "$SCRIPT_DIR")"
VAP_SDK_DIR="${DISPATCHER_DIR}/../vap-agent-sdk"

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

if [ ! -d "$VAP_SDK_DIR" ]; then
    echo "❌ vap-agent-sdk not found at $VAP_SDK_DIR"
    exit 1
fi

echo "✓ Dependencies OK"

# Ensure SDK is built
echo ""
echo "→ Building SDK..."
cd "$VAP_SDK_DIR"
if [ ! -d "dist" ]; then
    npm install && npm run build
fi
echo "✓ SDK built"

# Build the image
echo ""
echo "→ Building Docker image..."
cd "$DISPATCHER_DIR"

docker build \
    -f Dockerfile.job-agent \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    --build-arg VAP_SDK_DIR="$VAP_SDK_DIR" \
    .

echo ""
echo "✅ Image built: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "Size:"
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}"
echo ""
echo "Test run:"
echo "  docker run --rm ${IMAGE_NAME}:${IMAGE_TAG} --help"
