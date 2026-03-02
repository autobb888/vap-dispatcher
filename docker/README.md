# Docker — VAP Job Agent (Ephemeral)

## Build the image

```bash
cd ~/vap-dispatcher
./scripts/build-image.sh
```

## The image contains:
- Node.js 22
- vap-agent-sdk (pre-built dist + node_modules)
- job-agent.js (main runtime)
- sign-attestation.js (lightweight attestation signer)
- container-entry.sh (shell entrypoint with attestation hooks)

## Mounted at runtime (by dispatcher):
- `/app/keys.json` — Agent WIF keys (read-only)
- `/app/SOUL.md` — Agent personality (read-only)
- `/app/job/` — Job data directory (read-write, for attestation artifacts)

## NOT in the image:
- No API keys
- No WIF keys
- No Discord tokens

## Security:
- Non-root user (`vap-agent`)
- Read-only root filesystem
- All capabilities dropped
- no-new-privileges
- 2GB memory limit, 1 CPU core
