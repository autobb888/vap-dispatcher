#!/usr/bin/env node
/**
 * VAP Dispatcher CLI
 * 
 * Commands:
 *   start                    Start the dispatcher daemon
 *   stop                     Stop the dispatcher
 *   status                   Show status of all agents
 *   
 *   agent add <name>         Add a new agent
 *   agent remove <name>      Remove an agent
 *   agent start <name>       Start an agent container
 *   agent stop <name>        Stop an agent container
 *   agent restart <name>     Restart an agent container
 *   agent scale <name> <n>   Scale agent to n instances
 *   agent logs <name>        Tail agent logs
 *   
 *   bridge start             Start OpenClaw bridge
 *   bridge stop              Stop OpenClaw bridge
 */

const { Command } = require('commander');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VAP_DIR = path.join(os.homedir(), '.vap');
const DISPATCHER_DIR = path.join(VAP_DIR, 'dispatcher');
const AGENTS_DIR = path.join(DISPATCHER_DIR, 'agents');

const docker = new Docker();
const program = new Command();

// Ensure directories exist
function ensureDirs() {
  [VAP_DIR, DISPATCHER_DIR, AGENTS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  });
}

// Load dispatcher config
function loadConfig() {
  const configPath = path.join(DISPATCHER_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    return {
      apiUrl: process.env.VAP_API_URL || 'https://api.autobb.app',
      bridgePort: 18791,
      dispatcherPort: 18790,
      agentImage: 'vap/agent:latest',
    };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Save dispatcher config
function saveConfig(config) {
  fs.writeFileSync(
    path.join(DISPATCHER_DIR, 'config.json'),
    JSON.stringify(config, null, 2)
  );
}

program
  .name('vap-dispatcher')
  .description('Multi-agent orchestration for Verus Agent Platform')
  .version('0.1.0');

// Start dispatcher
program
  .command('start')
  .description('Start the dispatcher daemon')
  .action(async () => {
    ensureDirs();
    const config = loadConfig();
    
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     VAP Dispatcher                       ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(`API: ${config.apiUrl}`);
    console.log(`Bridge port: ${config.bridgePort}`);
    console.log(`Dispatcher port: ${config.dispatcherPort}\n`);
    
    // Check Docker
    try {
      await docker.ping();
      console.log('✓ Docker connected');
    } catch (e) {
      console.error('❌ Docker not available:', e.message);
      process.exit(1);
    }
    
    // Start bridge server
    console.log('\n→ Starting bridge server...');
    const { startBridge } = require('./bridge.js');
    await startBridge(config.bridgePort);
    console.log(`✓ Bridge listening on port ${config.bridgePort}`);
    
    // Start API server
    console.log('\n→ Starting dispatcher API...');
    const { startApi } = require('./api.js');
    await startApi(config.dispatcherPort);
    console.log(`✓ API listening on port ${config.dispatcherPort}`);
    
    console.log('\n✅ Dispatcher running');
    console.log('   Press Ctrl+C to stop\n');
    
    // Keep alive
    await new Promise(() => {});
  });

// Status command
program
  .command('status')
  .description('Show status of all agents')
  .action(async () => {
    ensureDirs();
    
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     Agent Status                         ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    try {
      const containers = await docker.listContainers({ all: true });
      const agents = containers.filter(c => 
        c.Names.some(n => n.startsWith('/vap-agent-'))
      );
      
      if (agents.length === 0) {
        console.log('No agents running.\n');
        return;
      }
      
      agents.forEach(agent => {
        const name = agent.Names[0].replace('/vap-agent-', '');
        const status = agent.State === 'running' ? '🟢' : '🔴';
        console.log(`${status} ${name.padEnd(20)} ${agent.State}`);
      });
      console.log('');
    } catch (e) {
      console.error('❌ Failed to get status:', e.message);
    }
  });

// Agent commands
const agentCmd = program
  .command('agent')
  .description('Manage agents');

agentCmd
  .command('add <name>')
  .description('Add a new agent')
  .option('-s, --soul <file>', 'SOUL.md file path')
  .option('-t, --type <type>', 'Agent type', 'autonomous')
  .action(async (name, options) => {
    ensureDirs();
    
    const agentDir = path.join(AGENTS_DIR, name);
    if (fs.existsSync(agentDir)) {
      console.error(`❌ Agent "${name}" already exists`);
      process.exit(1);
    }
    
    fs.mkdirSync(agentDir, { recursive: true });
    
    // Copy or create SOUL.md
    if (options.soul && fs.existsSync(options.soul)) {
      fs.copyFileSync(options.soul, path.join(agentDir, 'SOUL.md'));
    } else {
      fs.writeFileSync(path.join(agentDir, 'SOUL.md'), `# ${name} Agent\n\nDefault SOUL configuration.\n`);
    }
    
    // Create agent config
    fs.writeFileSync(
      path.join(agentDir, 'config.json'),
      JSON.stringify({
        name,
        type: options.type,
        createdAt: new Date().toISOString(),
        replicas: 1,
      }, null, 2)
    );
    
    console.log(`✅ Agent "${name}" created at ${agentDir}`);
  });

agentCmd
  .command('start <name>')
  .description('Start an agent container')
  .action(async (name) => {
    ensureDirs();
    const config = loadConfig();
    const agentDir = path.join(AGENTS_DIR, name);
    
    if (!fs.existsSync(agentDir)) {
      console.error(`❌ Agent "${name}" not found`);
      process.exit(1);
    }
    
    console.log(`→ Starting agent "${name}"...`);
    
    const { startAgent } = require('./container.js');
    await startAgent(name, agentDir, config);
    
    console.log(`✅ Agent "${name}" started`);
  });

agentCmd
  .command('stop <name>')
  .description('Stop an agent container')
  .action(async (name) => {
    console.log(`→ Stopping agent "${name}"...`);
    
    try {
      const container = docker.getContainer(`vap-agent-${name}`);
      await container.stop();
      await container.remove();
      console.log(`✅ Agent "${name}" stopped`);
    } catch (e) {
      console.error(`❌ Failed to stop: ${e.message}`);
    }
  });

agentCmd
  .command('logs <name>')
  .description('Tail agent logs')
  .action(async (name) => {
    try {
      const container = docker.getContainer(`vap-agent-${name}`);
      const stream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 100,
      });
      
      stream.pipe(process.stdout);
    } catch (e) {
      console.error(`❌ Failed to get logs: ${e.message}`);
    }
  });

// Parse CLI
program.parse();
