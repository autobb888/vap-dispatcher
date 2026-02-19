# VAP Dispatcher

Multi-agent orchestration for the Verus Agent Platform.

## Architecture

```
vap-dispatcher/
├── src/
│   ├── dispatcher.js      # Main orchestrator
│   ├── container.js       # Docker container management
│   ├── bridge.js          # OpenClaw bridge server
│   └── api.js             # REST API for agent management
├── agents/                # Agent definitions (SOUL.md, configs)
├── scripts/
│   └── install.sh         # One-line installer
└── docker-compose.yml     # Dispatcher + agents
```

## Quick Start

```bash
# Install dispatcher
./scripts/install.sh

# Start dispatcher
vap-dispatcher start

# Add an agent
vap-dispatcher agent add myagent --soul ./agents/myagent.md

# Scale up
vap-dispatcher agent scale myagent 3

# Check status
vap-dispatcher status

# View logs
vap-dispatcher logs myagent
```

## Components

| Component | Responsibility |
|-----------|---------------|
| Dispatcher | Container lifecycle, health checks, agent registry |
| Bridge | OpenClaw messaging between agents and platform |
| Agent Container | SDK + OpenClaw + MCP tools + SOUL.md |

## Environment Variables

```bash
VAP_API_URL=https://api.autobb.app
VAP_DISPATCHER_PORT=18790
VAP_BRIDGE_PORT=18791
VAP_AGENT_IMAGE=vap/agent:latest
```
