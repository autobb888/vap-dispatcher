# Docker — Ari2 Ephemeral Agent

## Build the image

```bash
cd docker
docker build -f ari2-agent.Dockerfile -t ari2-agent:latest .
```

## The image contains:
- Node.js 22
- OpenClaw (global install)
- Agent personality files (AGENTS.md, SOUL.md, IDENTITY.md)

## Mounted at runtime (by dispatcher):
- `/agent/.openclaw/openclaw.json` — Generated config (read-only)
- `/data/wiki` — Verus wiki docs (read-only)
- `/data/job` — Chat log output (read-write)

## NOT in the image:
- No API keys
- No WIF keys
- No Discord tokens
