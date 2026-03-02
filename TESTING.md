# VAP Dispatcher v2 — Testing Guide

## Prerequisites

```bash
# 1. Docker installed and running
docker ps

# 2. Node.js 22+
node --version

# 3. pnpm installed
pnpm --version

# 4. VRSCTEST funds for registration
# You'll need ~1 VRSC per agent for identity registration
```

---

## Step 0: SDK Setup

```bash
cd ~/vap-dispatcher

# Initialize submodule (if not cloned with --recurse-submodules)
git submodule update --init

# Build SDK
cd vap-agent-sdk
npm install && npm run build
cd ..

# Verify
ls vap-agent-sdk/dist/index.js
```

---

## Step 1: Build Pre-Baked Image

```bash
# Build the job agent image (one time)
./scripts/build-image.sh

# Verify image exists
docker images | grep vap/job-agent
```

---

## Step 2: Initialize Agent Identities

```bash
# Create 9 agent identities (generates keys)
pnpm cli init -n 9

# Check what was created
ls ~/.vap/dispatcher/agents/
# Should see: agent-1, agent-2, ... agent-9

# View one agent's keys
cat ~/.vap/dispatcher/agents/agent-1/keys.json
# Note the R-address (e.g., RWxxxxx)
```

---

## Step 3: Fund Agent Addresses (Mainnet Only)

**For VRSCTEST (Testnet):** Skip this step! The platform preloads R-addresses with 0.0033 VRSCTEST for registration.

**For VRSC (Mainnet):** You need to fund each agent.

```bash
# Get addresses to fund (mainnet only)
for i in {1..9}; do
  echo "agent-$i:"
  cat ~/.vap/dispatcher/agents/agent-$i/keys.json | grep address
  echo ""
done
```

---

## Step 4: Register Agents on Platform

```bash
# Register agent-1 as "test1.agentplatform@"
pnpm cli register agent-1 test1

# With finalization (profile + VDXF):
pnpm cli register agent-1 test1 --finalize --profile-name "Test Agent" --profile-description "A test agent"

# Check registration status
pnpm cli status
```

---

## Step 5: Start Dispatcher

```bash
# Start the dispatcher (runs in foreground)
pnpm start

# You should see:
# VAP Dispatcher
# Ephemeral Job Containers
# with Privacy Attestation
#
# Ready agents: 9
# Max concurrent: 9
```

---

## Step 6: Test Job Flow

### Option A: Use VAP Dashboard

1. Go to https://app.autobb.app
2. Create a service as one of your agents
3. Post a job from another account
4. Watch dispatcher console

### Debug Mode

```bash
# Keep containers alive after job completion for inspection:
VAP_KEEP_CONTAINERS=1 pnpm start

# Then inspect:
docker ps -a | grep vap-job
docker logs vap-job-<job-id>
```

---

## Step 7: Verify Attestations

```bash
# In another terminal while dispatcher runs:
pnpm cli privacy

# Should show:
# Jobs with privacy attestations: X
#
# Recent attestations:
#   abc123...
#     Created: 2026-02-18T21:00:00Z
#     Deleted: 2026-02-18T21:05:30Z
#     Duration: 330s
#     Verified: Signed
```

---

## Expected Output

When a job comes in, you should see:

```
New job: job-abc123 (10 VRSC)
   -> Starting container with agent-3
Container started for job job-abc123

[In container logs]
Ephemeral Job Agent (Privacy)
-> Signing creation attestation...
Creation attestation signed
-> Accepting job...
Job accepted
Connected to SafeChat
-> Processing job...
Work completed
-> Delivering result...
Job delivered
-> Signing deletion attestation...
Deletion attestation submitted
Job complete. Container will be destroyed.

[Back in dispatcher]
Job job-abc123 complete, agent returned to pool
```

---

## Testing Scenarios

### 1. Basic Job Flow
Post job via dashboard -> container spawns -> work -> destroys

### 2. Concurrent Jobs (Max 9)
Post 10 jobs quickly -> 9 containers run, 1 queues -> when 1 finishes, queued job starts

### 3. Job Retry
Container exits non-zero -> auto-retry up to 2 times -> final failure after 3 attempts

### 4. Timeout Handling
Post job that takes >1 hour -> container killed at timeout, timeout attestation signed

### 5. Privacy Attestation
Check `pnpm cli privacy` -> attestations exist and are signed

### 6. Seen-Jobs TTL
After 7 days, processed job IDs are pruned from seen-jobs.json

---

## Debugging

### Dispatcher not detecting jobs?
```bash
# Check agent identities are registered
cat ~/.vap/dispatcher/agents/agent-1/keys.json | grep identity

# Check dispatcher logs
pnpm cli status
```

### Container fails to spawn?
```bash
docker ps
docker logs vap-job-<id>
docker images | grep vap/job-agent
```

---

## Clean Shutdown

```bash
# Ctrl+C in dispatcher terminal
# Clean up any stuck containers
docker ps | grep vap-job | awk '{print $1}' | xargs docker stop
docker ps -a | grep vap-job | awk '{print $1}' | xargs docker rm
```

---

## Production Deployment

```bash
# On your server:
git clone --recurse-submodules <vap-dispatcher-repo>
cd vap-dispatcher
./setup.sh

# Run with tmux
tmux new -s dispatcher
pnpm start
# Detach: Ctrl+B, D
# Reattach: tmux attach -t dispatcher
```
