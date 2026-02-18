FROM node:22-slim

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl lsof && rm -rf /var/lib/apt/lists/*

# Copy OpenClaw from host (mounted at build time via volume or COPY)
# We copy the global node_modules install to avoid SSH git dep issues
COPY openclaw-pkg/ /usr/lib/node_modules/openclaw/
RUN ln -s /usr/lib/node_modules/openclaw/openclaw.mjs /usr/local/bin/openclaw

# Create directory structure
RUN mkdir -p /agent/.openclaw/workspace/memory /agent/.openclaw/canvas /agent/.openclaw/cron /agent/.cache /data/job /data/wiki /tmp

# Agent personality files baked in
COPY agent-files/AGENTS.md /agent/.openclaw/workspace/AGENTS.md
COPY agent-files/SOUL.md /agent/.openclaw/workspace/SOUL.md
COPY agent-files/IDENTITY.md /agent/.openclaw/workspace/IDENTITY.md

ENV OPENCLAW_HOME=/agent
ENV NODE_ENV=production

EXPOSE 18789

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s \
  CMD curl -sf http://127.0.0.1:18789/health || exit 1

CMD ["openclaw", "gateway", "--force"]
