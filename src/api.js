/**
 * Dispatcher REST API
 * 
 * Endpoints:
 *   GET  /api/agents           List all agents
 *   POST /api/agents          Create new agent
 *   GET  /api/agents/:id      Get agent details
 *   POST /api/agents/:id/start   Start agent
 *   POST /api/agents/:id/stop    Stop agent
 *   GET  /api/agents/:id/logs    Stream logs
 *   GET  /api/health          Health check
 */

const express = require('express');
const { listAgents, startAgent, stopAgent, getAgentStats } = require('./container.js');
const { getBridge } = require('./bridge.js');

const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    agents: getBridge()?.agents?.size || 0,
  });
});

// List agents
app.get('/api/agents', async (req, res) => {
  try {
    const agents = await listAgents();
    res.json({
      agents: agents.map(a => ({
        id: a.Id,
        name: a.Names[0].replace('/vap-agent-', ''),
        state: a.State,
        status: a.Status,
        image: a.Image,
      })),
    });
  } catch (e) {
    console.error('[API] Route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get agent details
app.get('/api/agents/:id', async (req, res) => {
  try {
    const stats = await getAgentStats(req.params.id);
    res.json({
      id: req.params.id,
      stats,
    });
  } catch (e) {
    console.error('[API] Route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start agent
app.post('/api/agents/:id/start', async (req, res) => {
  try {
    const { startAgent } = require('./container.js');
    await startAgent(req.params.id);
    res.json({ status: 'started' });
  } catch (e) {
    console.error('[API] Route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop agent
app.post('/api/agents/:id/stop', async (req, res) => {
  try {
    await stopAgent(req.params.id);
    res.json({ status: 'stopped' });
  } catch (e) {
    console.error('[API] Route error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send message to agent via bridge
app.post('/api/agents/:id/message', async (req, res) => {
  const bridge = getBridge();
  if (!bridge) {
    return res.status(503).json({ error: 'Bridge not running' });
  }
  
  const sent = bridge.sendToAgent(req.params.id, req.body);
  res.json({ sent });
});

// Global error handler — sanitize responses to avoid leaking internals
app.use((err, req, res, _next) => {
  console.error('[API] Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

function startApi(port = 18790) {
  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`[API] REST API listening on port ${port}`);
      resolve();
    });
  });
}

module.exports = {
  startApi,
  app,
};
