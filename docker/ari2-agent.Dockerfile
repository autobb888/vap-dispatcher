FROM node:22-slim

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install OpenClaw
RUN npm install -g openclaw

# Create directory structure
RUN mkdir -p /agent/.openclaw/workspace/memory /data/job /data/wiki /tmp

# Config, wiki, and memory index are mounted at runtime
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
