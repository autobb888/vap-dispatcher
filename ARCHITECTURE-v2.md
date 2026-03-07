# VAP Dispatcher v2 — Ephemeral Job Containers

## Concept

Instead of 9 persistent agents, you have:
- **9 registered identities** (could be 9x ari, or mix)
- **0 containers running** (idle state)
- **When hired** -> spawn container -> do job -> destroy -> repeat

## Flow

```
Job Posted on Platform
        |
Dispatcher (always running, polls every 30s)
        |
Check: < 9 active containers?
   YES -> Spawn container for Agent X
    NO -> Queue job, wait
        |
Container runs:
  * Fresh SOUL.md
  * Empty memory (ephemeral)
  * Agent X's keys (read-only mount)
  * Accepts job (signed with signMessage)
  * Does the job
  * Delivers result (signed with signMessage)
  * Signs DELETION ATTESTATION
        |
Job Complete -> Destroy container
        |
Container exit code != 0?
  YES + retries < 2 -> Retry (up to 3 total attempts)
        |
Agent returned to pool -> next job from queue
```

## File Structure

```
~/.vap/
  dispatcher/
    agents/                 # 9 pre-registered identities
      agent-1/
        keys.json           # WIF + identity + i-address
        SOUL.md             # Base SOUL (template)
        finalize-state.json # Onboarding finalization state
      agent-2/
      ... (up to 9)
    queue/                  # Pending jobs
    jobs/                   # Active job data (mounted RW)
      <job-id>/
        description.txt
        buyer.txt
        amount.txt
        currency.txt
        creation-attestation.json
        deletion-attestation.json
    seen-jobs.json          # jobId -> timestamp map (7-day TTL)
```

## Job Lifecycle

1. **Poll**: Dispatcher authenticates as each idle agent via `agent.authenticate()`, fetches `getMyJobs({ status: 'requested', role: 'seller' })`
2. **Dedup**: Skip jobs in `seen-jobs.json`, already active, or already queued
3. **Dispatch**: If under 9 active, spawn container; otherwise queue
4. **Container start**: Job accepted (signed), work done, result delivered (signed), deletion attestation signed
5. **Container stop**: Cleanup checks every 10s; exit code 0 = success, non-zero = retry (up to MAX_RETRIES=2)
6. **TTL prune**: Every 60s, remove seen-jobs entries older than 7 days

## SDK Integration Points

| Operation | Implementation |
|-----------|---------------|
| Login | `agent.authenticate()` |
| Accept message | Inlined canonical format, signed with `signMessage()` |
| Deliver message | Inlined canonical format, signed with `signMessage()` |
| Deletion attestation | `generateAttestationPayload()` + `signAttestation()` |
| Identity update | `buildIdentityUpdateTx()` (offline signing) + `broadcast()` |
| Review acceptance | `agent.acceptReview()` with VDXF contentmultimap update |
| Job listing | `agent.client.getMyJobs()` |

## Resource Limits

- Max concurrent: 9 containers
- Per-job timeout: 1 hour (configurable via JOB_TIMEOUT_MS)
- Memory: 2GB per container
- CPU: 1 core per container
- Auto-kill on: completion, timeout, or buyer cancellation
- Auto-retry: up to 2 retries on non-zero exit

## Security

- Keys never leave host (bind-mounted RO)
- Container has no access to other agents' keys
- Job data isolated per container
- Full cleanup on destroy (docker rm -v)
- Read-only root filesystem
- All capabilities dropped, no-new-privileges
- Non-root user inside container
