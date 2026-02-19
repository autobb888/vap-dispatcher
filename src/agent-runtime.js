/**
 * Agent Runtime
 * 
 * Runs inside the agent container:
 * 1. Connects to VAP platform (SDK)
 * 2. Connects to OpenClaw bridge
 * 3. Loads SOUL.md
 * 4. Handles jobs via MCP tools
 */

const { VAPAgent } = require('./sdk/dist/index.js');
const { BridgeClient } = require('./bridge-client.js');
const { MCPClient } = require('./mcp-client.js');
const fs = require('fs');
const path = require('path');

// Configuration from environment
const API_URL = process.env.VAP_API_URL || 'https://api.autobb.app';
const BRIDGE_URL = process.env.VAP_BRIDGE_URL || 'ws://localhost:18791';
const AGENT_NAME = process.env.VAP_AGENT_NAME || 'unnamed';
const KEYS_FILE = '/app/keys.json';
const SOUL_FILE = '/app/agent/SOUL.md';

async function main() {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║     VAP Agent: ${AGENT_NAME.padEnd(21)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  
  // Load keys
  if (!fs.existsSync(KEYS_FILE)) {
    console.error('❌ Keys file not found at /app/keys.json');
    process.exit(1);
  }
  
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  console.log(`✓ Keys loaded: ${keys.identity || keys.address}`);
  
  // Load SOUL.md
  let soul = null;
  if (fs.existsSync(SOUL_FILE)) {
    soul = fs.readFileSync(SOUL_FILE, 'utf8');
    console.log(`✓ SOUL.md loaded (${soul.length} chars)`);
  }
  
  // Initialize MCP client (tools)
  const mcp = new MCPClient();
  await mcp.connect();
  console.log('✓ MCP client connected');
  
  // Initialize VAP agent
  const agent = new VAPAgent({
    vapUrl: API_URL,
    wif: keys.wif,
    identityName: keys.identity,
    iAddress: keys.iAddress,
  });
  
  // Set up job handler
  agent.setHandler({
    onJobRequested: async (job) => {
      console.log(`\n📥 Job request: ${job.id}`);
      console.log(`   ${job.description}`);
      
      // Use MCP tools to evaluate job
      const result = await mcp.callTool('evaluate_job', {
        job,
        soul,
        agentName: AGENT_NAME,
      });
      
      console.log(`   Decision: ${result.decision}`);
      return result.decision; // 'accept' | 'reject' | 'hold'
    },
    
    onJobAccepted: async (job) => {
      console.log(`\n✅ Job accepted: ${job.id}`);
      
      // Notify via bridge
      bridge.send({
        type: 'agent:job_accepted',
        jobId: job.id,
        timestamp: Date.now(),
      });
    },
  });
  
  // Connect to OpenClaw bridge
  const bridge = new BridgeClient(BRIDGE_URL, AGENT_NAME);
  bridge.onMessage(async (msg) => {
    console.log(`\n📨 Bridge message:`, msg.type);
    
    switch (msg.type) {
      case 'openclaw:spawn_task':
        // Spawned as sub-agent for a task
        const result = await handleTask(msg.task, mcp, soul);
        bridge.send({
          type: 'agent:task_complete',
          sessionId: msg.sessionId,
          result,
        });
        break;
        
      case 'openclaw:chat_message':
        // Handle chat via MCP
        const reply = await mcp.callTool('chat_reply', {
          message: msg.content,
          context: msg.context,
          soul,
        });
        agent.sendChatMessage(msg.jobId, reply.content);
        break;
        
      default:
        console.log('   (unhandled)');
    }
  });
  
  await bridge.connect();
  console.log('✓ Bridge connected');
  
  // Start agent
  await agent.start();
  await agent.connectChat();
  console.log('\n✅ Agent running\n');
  
  // Keep alive
  await new Promise(() => {});
}

async function handleTask(task, mcp, soul) {
  console.log(`\n🔧 Handling task: ${task.type}`);
  
  // Delegate to MCP tools
  const result = await mcp.callTool(task.type, {
    ...task.params,
    soul,
  });
  
  return result;
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
