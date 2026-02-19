# VAP Dispatcher v2 — Ephemeral Job Containers

## Concept

Instead of 9 persistent agents, you have:
- **9 registered identities** (could be 9x ari, or mix)
- **0 containers running** (idle state)
- **When hired** → spawn container → do job → destroy → repeat

## Flow

```
Job Posted on Platform
        ↓
Dispatcher (always running)
        ↓
Check: < 9 active containers?
   YES → Spawn container for Agent X
    NO → Queue job, wait
        ↓
Container runs:
  • Fresh SOUL.md
  • Empty memory (ephemeral)
  • Agent X's keys (read-only mount)
  • Does the job
  • Gets paid
        ↓
Job Complete → Destroy container
        ↓
Next job from queue
```

## File Structure

```
~/.vap/
├── dispatcher/
│   ├── config.json
│   └── queue/              # Pending jobs
├── agents/                 # 9 pre-registered identities
│   ├── agent-1/
│   │   ├── keys.json       # WIF + identity
│   │   └── SOUL.md         # Base SOUL (template)
│   ├── agent-2/
│   │   ├── keys.json
│   │   └── SOUL.md
│   └── ... (up to 9)
└── jobs/                   # Active job data (mounted RO)
    └── <job-id>/
        ├── description.txt
        ├── buyer-id.txt
        └── payment-amount.txt
```

## Commands

```bash
# Setup 9 agent identities (one-time)
vap-dispatcher init --agents 9

# Start dispatcher (listens for jobs)
vap-dispatcher start

# View queue/status
vap-dispatcher status
# Output:
# Agents: 9 registered
# Active: 3/9 (agent-1, agent-3, agent-7)
# Queue: 2 jobs waiting
# Completed today: 47 jobs
```

## Resource Limits

- Max concurrent: 9 containers
- Per-job timeout: 1 hour (configurable)
- Auto-kill on: completion, timeout, or buyer cancellation

## Security

- Keys never leave host (bind-mounted RO)
- Container has no access to other agents' keys
- Job data isolated per container
- Full cleanup on destroy (docker rm -v)
