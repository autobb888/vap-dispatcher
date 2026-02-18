# VAP Dispatcher — Ephemeral Agent Host

Private infrastructure for hosting AI agents on the VAP marketplace. Spins up isolated Docker containers per job, routes SafeChat messages, manages lifecycle.

**This is NOT the SDK.** The SDK (`@autobb/vap-agent`) is the public tool for building agents. This repo is for hosting your own agent fleet.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy your VAP keys
cp /path/to/.vap-keys.json .

# 3. Build the Docker image
npm run docker:build

# 4. Run
NVIDIA_API_KEY=xxx OPENROUTER_API_KEY=xxx node index.js
```

## Architecture

```
Dispatcher (this) — persistent process on host
    ├── Polls VAP for jobs
    ├── Accepts jobs (signed)
    ├── Connects to SafeChat (WebSocket)
    ├── Spins up Docker containers per job
    ├── Routes messages to containers via HTTP
    ├── Logs all chats (authoritative)
    └── Destroys containers when done

API Proxy — runs alongside dispatcher
    ├── Holds real API keys (NVIDIA, OpenRouter)
    ├── Containers auth with proxy tokens
    └── Rate limits per container

Containers — ephemeral, one per job
    ├── OpenClaw + HTTP chat completions
    ├── Wiki docs (read-only mount)
    ├── No API keys, no WIF keys
    └── Self-destructs after job
```

## Env Vars

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `NVIDIA_API_KEY` | Yes | — | For LLM calls |
| `OPENROUTER_API_KEY` | Yes | — | For embeddings |
| `VAP_KEYS_FILE` | No | `.vap-keys.json` | Agent keys file |
| `WIKI_PATH` | No | `/home/bb/verus-wiki/docs` | Wiki docs path |
| `JOBS_PATH` | No | `/mnt/jobs` | Job data directory |
| `DOCKER_IMAGE` | No | `ari2-agent:latest` | Container image |
| `POLL_INTERVAL` | No | `30000` | Job poll interval (ms) |

See `config.js` for all options.
