/**
 * Container management for VAP agents
 */

const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');

const docker = new Docker();

/**
 * Start an agent container
 */
async function startAgent(name, agentDir, config) {
  // Check if already running
  try {
    const existing = docker.getContainer(`vap-agent-${name}`);
    const info = await existing.inspect();
    if (info.State.Running) {
      console.log(`Agent "${name}" already running`);
      return;
    }
  } catch {
    // Not running, continue
  }
  
  // Load agent config
  const agentConfig = JSON.parse(
    fs.readFileSync(path.join(agentDir, 'config.json'), 'utf8')
  );
  
  // Create container
  const container = await docker.createContainer({
    name: `vap-agent-${name}`,
    Image: config.agentImage,
    Env: [
      `VAP_API_URL=${config.apiUrl}`,
      `VAP_AGENT_NAME=${name}`,
      `VAP_AGENT_TYPE=${agentConfig.type}`,
      `VAP_BRIDGE_URL=ws://host.docker.internal:${config.bridgePort}`,
    ],
    HostConfig: {
      Binds: [
        `${agentDir}:/app/agent:ro`,
        `${path.join(process.env.HOME, '.vap/keys.json')}:/app/keys.json:ro`,
      ],
      RestartPolicy: {
        Name: 'unless-stopped',
      },
      // Add Docker socket for OpenClaw bridge to spawn sibling containers
      ...(process.platform === 'linux' ? {
        GroupAdd: ['docker'],
      } : {}),
    },
    Labels: {
      'vap.agent.name': name,
      'vap.agent.type': agentConfig.type,
      'vap.managed': 'true',
    },
  });
  
  await container.start();
  return container;
}

/**
 * Stop an agent container
 */
async function stopAgent(name) {
  const container = docker.getContainer(`vap-agent-${name}`);
  await container.stop();
  await container.remove();
}

/**
 * List all managed agent containers
 */
async function listAgents() {
  const containers = await docker.listContainers({ all: true });
  return containers.filter(c => 
    c.Labels['vap.managed'] === 'true'
  );
}

/**
 * Get container stats
 */
async function getAgentStats(name) {
  const container = docker.getContainer(`vap-agent-${name}`);
  const stats = await container.stats({ stream: false });
  return {
    cpu: calculateCpuPercent(stats),
    memory: stats.memory_stats.usage / 1024 / 1024, // MB
  };
}

function calculateCpuPercent(stats) {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  return (cpuDelta / systemDelta) * 100;
}

module.exports = {
  startAgent,
  stopAgent,
  listAgents,
  getAgentStats,
};
