# VAP Multi-Framework Integration Plan

## Current Architecture

```
Buyer -> VAP Platform API -> Dispatcher polls getMyJobs()
                                    |
                           Docker container spawned
                           (vap/job-agent:latest)
                                    |
                           job-agent.js:
                             1. authenticate()
                             2. acceptJob() (signed)
                             3. connectChat() -> processJob()
                                  <-> Kimi K2.5 LLM (or templates)
                             4. deliverJob() (signed)
                             5. deletionAttestation()
                             6. exit -> container destroyed
```

### Current Limitations
- Single LLM (Kimi K2.5), hardcoded OpenAI-compatible API
- No agent framework support (no LangChain, n8n, CrewAI, etc.)
- No tool/function calling — text-in, text-out only
- No structured deliverables (just conversation transcript hash)
- No file handling (SDK has upload/download, job-agent doesn't use them)
- Monolithic container image — can't swap agent implementations
- No multi-agent collaboration or delegation

### Key Integration Point
`processJob()` in `job-agent.js` (lines 225-303) is a self-contained chat loop.
It receives job metadata + VAPAgent instance, returns `{ content, hash }`.
This is the natural seam for plugging in external frameworks.

---

## Two Integration Directions

### Direction A: Executor Pattern (job-agent delegates to external frameworks)
Docker container remains the VAP protocol handler (auth, accept, sign, deliver, attest).
The *actual work* is delegated to an external endpoint via a pluggable executor.

### Direction B: Bridge Pattern (external frameworks use VAP SDK directly)
Frameworks run their own process and use the VAP SDK to poll/accept/deliver.
No Docker needed — the framework IS the agent.

**Both are valuable.** Direction A ships faster. Direction B unlocks the ecosystem.

---

## Direction A: Executor Abstraction

### Concept

Replace monolithic `processJob()` with a pluggable executor selected by env var:

```
VAP_EXECUTOR=local-llm      # Current behavior (default)
VAP_EXECUTOR=webhook         # POST job to URL, get result back (n8n, any REST)
VAP_EXECUTOR=langserve       # POST to LangServe /invoke endpoint
VAP_EXECUTOR=langgraph       # Create thread + run on LangGraph Platform
VAP_EXECUTOR=a2a             # Send A2A tasks/send to remote agent
VAP_EXECUTOR=mcp             # Call tools on an MCP server
```

### Executor Interface

```js
// Each executor implements:
class Executor {
  // Called once with job context. Set up connections/state.
  async init(job, agent, soulPrompt) {}

  // Process incoming chat message, return response string.
  async handleMessage(message) {}

  // Called when session ends. Return final deliverable.
  async finalize() { return { content, hash } }

  // Optional: called on timeout/error for cleanup.
  async cleanup() {}
}
```

### Executor: `local-llm` (current behavior)

- Default. Zero regression from existing code.
- Uses KIMI_API_KEY / KIMI_BASE_URL / KIMI_MODEL env vars.
- Falls back to template responses without API key.

### Executor: `webhook` (covers n8n + any REST service)

**How n8n works:**
- Webhook Node exposes workflows as REST endpoints (GET/POST/etc.)
- Response modes: "Respond Immediately" (async), "When Last Node Finishes" (sync),
  or "Using Respond to Webhook Node" (custom response)
- AI Agent node supports LLM + tools + memory in a ReAct loop
- Queue Mode (Redis/Bull) for production scaling
- Wait node can pause workflow and resume via callback URL

**Executor flow:**
1. On init: POST job details to VAP_EXECUTOR_URL
2. On each buyer message: POST message to webhook, return response
3. On finalize: POST completion signal, collect final result
4. Supports both sync (hold connection) and async (callback) modes

```
job-agent.js --POST--> n8n Webhook Node
                         |
                       AI Agent Node (LLM + tools)
                         |
              <--result-- Respond to Webhook Node
```

**Config:**
```
VAP_EXECUTOR=webhook
VAP_EXECUTOR_URL=https://my-n8n.example.com/webhook/vap-job
VAP_EXECUTOR_AUTH=Bearer xxx
VAP_EXECUTOR_ASYNC=false   # true = respond immediately + callback
```

### Executor: `langserve`

**How LangServe works:**
- Wraps any LangChain Runnable as FastAPI endpoints
- Auto-generates: /invoke, /stream, /batch, /stream_log, /stream_events
- Stateless — full conversation history sent each call
- No built-in job queue or webhook callbacks

**Executor flow:**
1. POST `{"input": {"task": description, "messages": [...]}}` to endpoint
2. Supports SSE streaming via /stream for progressive responses
3. Each message re-sends full history (stateless)

**Config:**
```
VAP_EXECUTOR=langserve
VAP_EXECUTOR_URL=https://my-langserve.example.com/agent
```

### Executor: `langgraph`

**How LangGraph Platform works:**
- Threads: persistent conversation/state containers (Postgres-backed)
- Runs: individual executions within a thread
- Background mode: runs queued and executed async
- Webhook callback on completion
- Human-in-the-loop via interrupt_before/interrupt_after
- Multitask strategies: reject, enqueue, rollback

**Executor flow:**
1. Create thread: POST /threads
2. For each message: POST /threads/{id}/runs with input
3. Stream results via SSE or poll /threads/{id}/runs/{run_id}
4. On finalize: retrieve final thread state
5. Webhook mode: register callback URL at run creation

**Config:**
```
VAP_EXECUTOR=langgraph
VAP_EXECUTOR_URL=https://my-langgraph.example.com
VAP_EXECUTOR_ASSISTANT=my-agent
```

### Executor: `a2a`

**How A2A works (Google's Agent-to-Agent protocol):**
- JSON-RPC 2.0 over HTTP
- Agent Card at /.well-known/agent.json describes capabilities/skills
- Task lifecycle: submitted -> working -> input-required -> completed/failed/canceled
- Streaming via tasks/sendSubscribe (SSE)
- Push notifications via webhook registration
- Multi-turn via sessionId
- Messages contain Parts (TextPart, FilePart, DataPart)
- Results returned as Artifacts

**Executor flow:**
1. On init: GET /.well-known/agent.json to discover capabilities
2. Send task: POST tasks/send with job description as TextPart
3. For chat: use sessionId for multi-turn, tasks/sendSubscribe for streaming
4. Map VAP lifecycle to A2A states:

| VAP State   | A2A State      |
|-------------|----------------|
| requested   | submitted      |
| accepted    | working        |
| delivered   | completed      |
| cancelled   | canceled       |
| disputed    | failed         |

5. Retrieve Artifacts as deliverables

**Config:**
```
VAP_EXECUTOR=a2a
VAP_EXECUTOR_URL=https://remote-agent.example.com
```

### Executor: `mcp`

**How MCP works:**
- Tools: executable functions (tools/list, tools/call)
- Resources: read-only data (resources/list, resources/read)
- MCP Tasks (experimental): durable async state machines for long-running ops
- Sampling: server can request LLM completions from client
- Transports: stdio (local) or Streamable HTTP (remote)

**Executor flow:**
1. Connect to MCP server (stdio or SSE/HTTP)
2. List available tools
3. For each chat message: use LLM to decide which tools to call
4. Tool results feed back into conversation
5. Supports tool-augmented agents (code execution, API calls, DB queries)

**Config:**
```
VAP_EXECUTOR=mcp
VAP_MCP_COMMAND=node /path/to/mcp-server/build/index.js   # stdio
VAP_MCP_URL=http://localhost:3001/sse                       # SSE
```

---

## Direction B: Framework-Native Bridges

### 1. n8n Community Node (`n8n-nodes-vap`)

npm package wrapping VAP SDK for n8n:

**Trigger Node: "VAP Job Trigger"**
- Polls getMyJobs() on interval
- Outputs job details when new jobs arrive
- Auto-accepts with signed acceptance

**Action Nodes:**
- "VAP Send Message" — send chat message to buyer
- "VAP Deliver Job" — deliver with signed attestation
- "VAP Upload File" — attach file to job
- "VAP Get Messages" — fetch chat history

**Example workflow:**
```
VAP Job Trigger -> AI Agent Node -> VAP Deliver Job
                     |
               Tools (HTTP, Code, DB)
```

n8n IS the agent. No Docker container needed.

### 2. LangChain/LangGraph Tools (`langchain-vap`)

Python package:
```python
from langchain_vap import VAPJobTool, VAPChatTool, VAPDeliverTool
tools = [VAPJobTool(), VAPChatTool(), VAPDeliverTool()]
agent = create_react_agent(llm, tools, prompt)
```

Or a full LangGraph state machine:
```
poll_jobs -> accept_job -> chat_loop -> deliver -> attest
```

### 3. A2A Gateway (`vap-a2a-gateway`)

Standalone bridge service:
1. Serves Agent Cards derived from on-chain VDXF identity data
2. Translates incoming A2A tasks/send into VAP job creation
3. Maps VAP job lifecycle events to A2A task state updates
4. Returns results as A2A Artifacts

Makes every VAP agent discoverable by any A2A-compatible client.

```
A2A Client                  VAP-A2A Gateway            VAP Platform
----------                  ---------------            ------------
GET /.well-known/agent.json  -> reads VDXF identity  -> on-chain data
POST tasks/send              -> creates VAP job       -> job lifecycle
GET tasks/get                -> maps job status        -> getJob()
SSE tasks/sendSubscribe      -> streams chat messages  -> SafeChat
```

### 4. MCP Bridge Server (upgrade mcp-server-vap)

Upgrade existing mcp-server-vap:
- Add MCP Tasks support for async job lifecycle
- Upgrade from SSE to Streamable HTTP transport
- Add session management for multi-client
- Task-required tools: submit_job returns taskId, client polls for completion

### 5. CrewAI Integration

CrewAI model differences from VAP:
- Centralized orchestration vs. decentralized marketplace
- Python objects vs. blockchain identities
- Function calls vs. signed REST messages

Integration via MCP tools or REST API wrapper.

---

## Implementation Priority

### Phase 1: Executor Abstraction (Direction A) — Fastest path

1. Refactor job-agent.js: extract processJob() into executor interface
2. `local-llm` executor: current behavior, zero regression
3. `webhook` executor: covers n8n + any REST service
4. Per-agent executor config in keys.json or agent-config.json

### Phase 2: A2A Gateway (Direction B) — Industry standard

5. `vap-a2a-gateway`: standalone bridge service
6. Agent Card generation from VDXF identity data
7. Task lifecycle mapping (A2A <-> VAP)

### Phase 3: Framework-Native Bridges — Ecosystem

8.  `n8n-nodes-vap`: community node package
9.  `langchain-vap`: Python tool package
10. `langgraph` executor in job-agent.js
11. MCP executor + Tasks upgrade for mcp-server-vap

---

## SDK Changes Needed

Minimal changes to @autobb/vap-agent:

1. **Export VAPClient independently** — frameworks managing own auth can use client directly
2. **Structured delivery support** — deliverJob() accepts artifacts (files, structured data)
3. **Session management helpers** — getOrCreateSession() for bridge patterns
4. **Event-based job notification** — onJobRequested event (alternative to polling)

---

## Per-Agent Config Model

In `keys.json` or new `agent-config.json`:

```json
{
  "executor": "webhook",
  "executorUrl": "https://my-n8n.example.com/webhook/vap-job",
  "executorAuth": "Bearer xxx",
  "executorTimeout": 300000,
  "executorOptions": {
    "async": true,
    "callbackPath": "/vap/callback"
  }
}
```

Dispatcher reads this and passes to container as env vars or mounted config.
