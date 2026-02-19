/**
 * OpenClaw Bridge Server
 * 
 * WebSocket server that agents connect to for:
 * - Receiving messages from OpenClaw
 * - Sending responses back
 * - Spawning sub-agents (if authorized)
 */

const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

class BridgeServer {
  constructor(port) {
    this.port = port;
    this.agents = new Map(); // agentId -> ws connection
    this.sessions = new Map(); // sessionId -> agentId
    // P2-2: Simple token secret (in production, use proper key derivation)
    this.tokenSecret = process.env.VAP_BRIDGE_SECRET || 'dev-secret-change-in-production';
  }
  
  // P2-2: Verify agent token
  verifyAgentToken(agentId, token) {
    if (!token || !agentId) return false;
    // Simple HMAC verification
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', this.tokenSecret)
      .update(agentId)
      .digest('hex')
      .substring(0, 32);
    return token === expected;
  }
  
  async start() {
    const server = http.createServer();
    this.wss = new WebSocket.Server({ server });
    
    this.wss.on('connection', (ws, req) => {
      const agentId = req.url.split('/').pop();
      
      // P2-2: Token authentication
      const token = req.headers['x-agent-token'];
      if (!this.verifyAgentToken(agentId, token)) {
        console.log(`[Bridge] Rejected connection for ${agentId}: Invalid token`);
        ws.close(1008, 'Invalid token');
        return;
      }
      
      console.log(`[Bridge] Agent connected: ${agentId}`);
      this.agents.set(agentId, ws);
      
      ws.on('message', (data) => {
        this.handleMessage(agentId, data);
      });
      
      ws.on('close', () => {
        console.log(`[Bridge] Agent disconnected: ${agentId}`);
        this.agents.delete(agentId);
      });
      
      ws.on('error', (err) => {
        console.error(`[Bridge] Error for ${agentId}:`, err.message);
      });
      
      // Send welcome message
      ws.send(JSON.stringify({
        type: 'bridge:connected',
        agentId,
        timestamp: Date.now(),
      }));
    });
    
    return new Promise((resolve) => {
      server.listen(this.port, () => {
        console.log(`[Bridge] Listening on port ${this.port}`);
        resolve();
      });
    });
  }
  
  handleMessage(agentId, data) {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'agent:spawn':
          this.handleSpawn(agentId, msg);
          break;
          
        case 'agent:message':
          // Forward to OpenClaw (placeholder)
          console.log(`[Bridge] Message from ${agentId}:`, msg.content);
          break;
          
        case 'agent:status':
          this.broadcastStatus(agentId, msg.status);
          break;
          
        default:
          console.log(`[Bridge] Unknown message type: ${msg.type}`);
      }
    } catch (e) {
      console.error('[Bridge] Failed to parse message:', e.message);
    }
  }
  
  async handleSpawn(parentAgentId, msg) {
    console.log(`[Bridge] Spawn request from ${parentAgentId}:`, msg.task);
    
    // Generate session ID
    const sessionId = uuidv4();
    
    // Create sub-agent container (sibling to parent)
    const { spawnSubAgent } = require('./container.js');
    const subAgent = await spawnSubAgent(parentAgentId, msg.task, sessionId);
    
    // Notify parent
    const parent = this.agents.get(parentAgentId);
    if (parent) {
      parent.send(JSON.stringify({
        type: 'bridge:spawned',
        sessionId,
        agentId: subAgent.id,
      }));
    }
    
    this.sessions.set(sessionId, subAgent.id);
  }
  
  broadcastStatus(agentId, status) {
    // Could broadcast to monitoring dashboard
  }
  
  // Send message to specific agent
  sendToAgent(agentId, message) {
    const ws = this.agents.get(agentId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
  
  // Broadcast to all agents
  broadcast(message) {
    this.agents.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
  }
}

// Singleton instance
let server = null;

async function startBridge(port = 18791) {
  server = new BridgeServer(port);
  await server.start();
  return server;
}

function getBridge() {
  return server;
}

module.exports = {
  startBridge,
  getBridge,
  BridgeServer,
};
