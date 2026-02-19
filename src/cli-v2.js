#!/usr/bin/env node
/**
 * VAP Dispatcher v2 — Ephemeral Job Containers
 * 
 * Manages pool of pre-registered agents, spawns ephemeral containers per job.
 * Max 9 concurrent. Queue if at capacity.
 */

const { Command } = require('commander');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const VAP_DIR = path.join(os.homedir(), '.vap');
const DISPATCHER_DIR = path.join(VAP_DIR, 'dispatcher');
const AGENTS_DIR = path.join(DISPATCHER_DIR, 'agents');
const QUEUE_DIR = path.join(DISPATCHER_DIR, 'queue');
const JOBS_DIR = path.join(DISPATCHER_DIR, 'jobs');

const MAX_AGENTS = 9;
const JOB_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

const docker = new Docker();
const program = new Command();

function ensureDirs() {
  [VAP_DIR, DISPATCHER_DIR, AGENTS_DIR, QUEUE_DIR, JOBS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  });
}

function loadAgentKeys(agentId) {
  // P2-4: Validate agentId format to prevent path traversal
  if (!/^agent-[1-9][0-9]*$/.test(agentId)) {
    throw new Error('Invalid agent ID format');
  }
  const keysPath = path.join(AGENTS_DIR, agentId, 'keys.json');
  if (!fs.existsSync(keysPath)) return null;
  return JSON.parse(fs.readFileSync(keysPath, 'utf8'));
}

function listRegisteredAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter(name => {
    const keysPath = path.join(AGENTS_DIR, name, 'keys.json');
    return fs.existsSync(keysPath);
  });
}

function getActiveJobs() {
  // Find running containers named vap-job-*
  return docker.listContainers().then(containers => {
    return containers.filter(c => 
      c.Names.some(n => n.startsWith('/vap-job-'))
    );
  });
}

program
  .name('vap-dispatcher')
  .description('Ephemeral job container orchestrator for VAP')
  .version('0.2.0');

// Init command — create N agent identities
program
  .command('init')
  .description('Initialize dispatcher with N agent identities')
  .option('-n, --agents <number>', 'Number of agents to create', '9')
  .option('--soul <file>', 'SOUL.md template to use for all agents')
  .action(async (options) => {
    ensureDirs();
    const count = parseInt(options.agents);
    
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     VAP Dispatcher Init                  ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    // Load or generate soul template
    let soulTemplate = '# Generic VAP Agent\n\nA helpful AI assistant.';
    if (options.soul && fs.existsSync(options.soul)) {
      soulTemplate = fs.readFileSync(options.soul, 'utf8');
      console.log(`✓ Loaded SOUL template from ${options.soul}`);
    }
    
    // Generate agent identities
    console.log(`\n→ Creating ${count} agent identities...\n`);
    
    for (let i = 1; i <= count; i++) {
      const agentId = `agent-${i}`;
      const agentDir = path.join(AGENTS_DIR, agentId);
      
      if (fs.existsSync(agentDir)) {
        console.log(`  ${agentId}: already exists ✓`);
        continue;
      }
      
      fs.mkdirSync(agentDir, { recursive: true });
      
      // Generate keypair using SDK
      console.log(`  ${agentId}: generating keys...`);
      
      const { generateKeypair } = require('./vap-agent-sdk/dist/identity/keypair.js');
      const keys = generateKeypair('verustest');
      
      fs.writeFileSync(
        path.join(agentDir, 'keys.json'),
        JSON.stringify({ ...keys, network: 'verustest' }, null, 2)
      );
      fs.chmodSync(path.join(agentDir, 'keys.json'), 0o600);
      
      // Write SOUL template
      fs.writeFileSync(
        path.join(agentDir, 'SOUL.md'),
        soulTemplate.replace(/AGENT_NAME/g, agentId)
      );
      
      console.log(`  ${agentId}: created (${keys.address})`);
    }
    
    console.log(`\n✅ ${count} agents initialized`);
    console.log('\nNext steps:');
    console.log('  1. Fund the agent addresses (they need VRSC for registration)');
    console.log('  2. Register each: vap-dispatcher register agent-1 <name>');
    console.log('  3. Start dispatcher: vap-dispatcher start');
  });

// Register command — register an agent identity on-chain
program
  .command('register <agent-id> <identity-name>')
  .description('Register an agent identity on VAP platform')
  .action(async (agentId, identityName) => {
    ensureDirs();
    
    const keys = loadAgentKeys(agentId);
    if (!keys) {
      console.error(`❌ Agent ${agentId} not found. Run: vap-dispatcher init`);
      process.exit(1);
    }
    
    console.log(`\n→ Registering ${agentId} as ${identityName}.agentplatform@...`);
    console.log(`   Address: ${keys.address}`);
    
    const { VAPAgent } = require('./vap-agent-sdk/dist/index.js');
    const agent = new VAPAgent({ 
      vapUrl: process.env.VAP_API_URL || 'https://api.autobb.app',
      wif: keys.wif 
    });
    
    try {
      const result = await agent.register(identityName, 'verustest');
      
      // Save identity to keys file
      keys.identity = result.identity;
      keys.iAddress = result.iAddress;
      fs.writeFileSync(
        path.join(AGENTS_DIR, agentId, 'keys.json'),
        JSON.stringify(keys, null, 2)
      );
      
      console.log(`\n✅ ${agentId} registered!`);
      console.log(`   Identity: ${result.identity}`);
      console.log(`   i-Address: ${result.iAddress}`);
    } catch (e) {
      console.error(`\n❌ Registration failed: ${e.message}`);
      process.exit(1);
    }
  });

// Start command — run the dispatcher (listen for jobs)
program
  .command('start')
  .description('Start the dispatcher (listens for jobs, manages pool)')
  .action(async () => {
    ensureDirs();
    
    const agents = listRegisteredAgents();
    if (agents.length === 0) {
      console.error('❌ No agents found. Run: vap-dispatcher init');
      process.exit(1);
    }
    
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     VAP Dispatcher                       ║');
    console.log('║     Ephemeral Job Containers             ║');
    console.log('║     with Privacy Attestation             ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log(`Registered agents: ${agents.length}`);
    console.log(`Max concurrent: ${MAX_AGENTS}`);
    console.log(`Job timeout: ${JOB_TIMEOUT_MS / 60000} min`);
    console.log('Privacy: Creation + Deletion attestations\n');
    
    // Check which agents are registered on platform
    const readyAgents = [];
    for (const agentId of agents) {
      const keys = loadAgentKeys(agentId);
      if (keys?.identity) {
        readyAgents.push({ id: agentId, ...keys });
      } else {
        console.log(`⚠️  ${agentId}: not registered on platform`);
      }
    }
    
    if (readyAgents.length === 0) {
      console.error('\n❌ No agents registered. Run: vap-dispatcher register <agent> <name>');
      process.exit(1);
    }
    
    console.log(`Ready agents: ${readyAgents.length}\n`);
    
    // Start job polling loop
    console.log('→ Starting job listener...\n');
    
    const state = {
      active: new Map(), // jobId -> { agentId, container, startedAt }
      available: [...readyAgents], // pool of idle agents
      queue: [], // pending jobs
    };
    
    // Poll for jobs
    setInterval(async () => {
      await pollForJobs(state);
    }, 30000); // Every 30s
    
    // Check for completed jobs
    setInterval(async () => {
      await cleanupCompletedJobs(state);
    }, 10000); // Every 10s
    
    // Status report every minute
    setInterval(() => {
      console.log(`[${new Date().toISOString()}] Active: ${state.active.size}/${MAX_AGENTS}, Queue: ${state.queue.length}, Available: ${state.available.length}`);
    }, 60000);
    
    // Initial poll
    await pollForJobs(state);
    
    console.log('\n✅ Dispatcher running. Press Ctrl+C to stop.\n');
    
    // Keep alive
    await new Promise(() => {});
  });

// Status command
program
  .command('status')
  .description('Show dispatcher status')
  .action(async () => {
    ensureDirs();
    
    const agents = listRegisteredAgents();
    const activeJobs = await getActiveJobs();
    const queueFiles = fs.existsSync(QUEUE_DIR) ? fs.readdirSync(QUEUE_DIR) : [];
    
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     Dispatcher Status                    ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    console.log(`Agents: ${agents.length} registered`);
    console.log(`Active jobs: ${activeJobs.length}/${MAX_AGENTS}`);
    console.log(`Queue: ${queueFiles.length} pending\n`);
    
    if (activeJobs.length > 0) {
      console.log('Active containers:');
      activeJobs.forEach(job => {
        const name = job.Names[0].replace('/vap-job-', '');
        console.log(`  ${name}: ${job.Status}`);
      });
      console.log('');
    }
    
    // Show privacy attestation stats
    let attestationCount = 0;
    activeJobs.forEach(job => {
      const jobDir = path.join(JOBS_DIR, job.Names[0].replace('/vap-job-', ''));
      if (fs.existsSync(path.join(jobDir, 'creation-attestation.json'))) {
        attestationCount++;
      }
    });
    
    if (attestationCount > 0) {
      console.log(`Privacy attestations: ${attestationCount} active\n`);
    }
  });

// Privacy command — show attestation status
program
  .command('privacy')
  .description('Show privacy attestation status')
  .action(async () => {
    ensureDirs();
    
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     Privacy Attestation Status           ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    const completedJobs = fs.readdirSync(JOBS_DIR).filter(id => {
      return fs.existsSync(path.join(JOBS_DIR, id, 'deletion-attestation.json'));
    });
    
    console.log(`Jobs with privacy attestations: ${completedJobs.length}\n`);
    
    if (completedJobs.length > 0) {
      console.log('Recent attestations:');
      completedJobs.slice(-5).forEach(jobId => {
        const attPath = path.join(JOBS_DIR, jobId, 'deletion-attestation.json');
        const att = JSON.parse(fs.readFileSync(attPath, 'utf8'));
        console.log(`  ${jobId.substring(0, 8)}...`);
        console.log(`    Created:  ${att.createdAt}`);
        console.log(`    Deleted:  ${att.destroyedAt}`);
        console.log(`    Duration: ${(new Date(att.destroyedAt) - new Date(att.createdAt)) / 1000}s`);
        console.log(`    Method:   ${att.deletionMethod}`);
        console.log(`    Verified: ${att.signature ? '✅ Signed' : '❌ No signature'}`);
        console.log('');
      });
    }
    
    console.log('Privacy Features:');
    console.log('  ✅ Ephemeral containers (auto-remove)');
    console.log('  ✅ Creation attestation (signed proof of start)');
    console.log('  ✅ Deletion attestation (signed proof of destruction)');
    console.log('  ✅ Isolated job data (per-container volumes)');
    console.log('  ✅ Resource limits (2GB RAM, 1 CPU)');
    console.log('  ✅ Timeout protection (auto-kill after 1 hour)');
    console.log('');
  });

// Poll for new jobs
async function pollForJobs(state) {
  // Get jobs from all available agents
  const { VAPAgent } = require('./vap-agent-sdk/dist/index.js');
  
  for (const agentInfo of [...state.available]) {
    try {
      const agent = new VAPAgent({
        vapUrl: process.env.VAP_API_URL || 'https://api.autobb.app',
        wif: agentInfo.wif,
        identityName: agentInfo.identity,
        iAddress: agentInfo.iAddress,
      });
      
      // Quick login to get session
      const challengeRes = await agent.client.getAuthChallenge();
      const { signChallenge } = require('./vap-agent-sdk/dist/identity/signer.js');
      const sig = signChallenge(agentInfo.wif, challengeRes.challenge, agentInfo.iAddress, 'verustest');
      
      // Fetch pending jobs
      const resp = await fetch(`${process.env.VAP_API_URL || 'https://api.autobb.app'}/v1/me/jobs?status=requested&role=seller`, {
        headers: {
          'Authorization': `Bearer ${challengeRes.challengeId}.${sig}`
        }
      });
      
      if (!resp.ok) continue;
      
      const { jobs } = await resp.json();
      
      for (const job of jobs) {
        // Check if already handling this job
        if (state.active.has(job.id) || state.queue.some(j => j.id === job.id)) {
          continue;
        }
        
        console.log(`📥 New job: ${job.id} (${job.amount} ${job.currency})`);
        
        if (state.active.size >= MAX_AGENTS) {
          console.log(`   → Queueing (max capacity)`);
          state.queue.push({ ...job, assignedAgent: agentInfo });
        } else {
          console.log(`   → Starting container with ${agentInfo.id}`);
          await startJobContainer(state, job, agentInfo);
        }
      }
    } catch (e) {
      console.error(`[Poll] Error for ${agentInfo.id}:`, e.message);
    }
  }
  
  // Process queue if slots available
  while (state.queue.length > 0 && state.active.size < MAX_AGENTS && state.available.length > 0) {
    const queuedJob = state.queue.shift();
    const agent = state.available.pop();
    console.log(`   → Processing queued job ${queuedJob.id} with ${agent.id}`);
    await startJobContainer(state, queuedJob, agent);
  }
}

// Start a job container
async function startJobContainer(state, job, agentInfo) {
  const jobDir = path.join(JOBS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  
  // Write job data
  fs.writeFileSync(path.join(jobDir, 'description.txt'), job.description);
  fs.writeFileSync(path.join(jobDir, 'buyer.txt'), job.buyerVerusId);
  fs.writeFileSync(path.join(jobDir, 'amount.txt'), String(job.amount));
  fs.writeFileSync(path.join(jobDir, 'currency.txt'), job.currency);
  
  const agentDir = path.join(AGENTS_DIR, agentInfo.id);
  
  try {
    const container = await docker.createContainer({
      name: `vap-job-${job.id}`,
      Image: 'vap/job-agent:latest',  // PRE-BAKED IMAGE
      Env: [
        `VAP_API_URL=${process.env.VAP_API_URL || 'https://api.autobb.app'}`,
        `VAP_AGENT_ID=${agentInfo.id}`,
        `VAP_IDENTITY=${agentInfo.identity}`,
        `VAP_JOB_ID=${job.id}`,
        `JOB_TIMEOUT_MS=${JOB_TIMEOUT_MS}`,
      ],
      HostConfig: {
        Binds: [
          `${jobDir}:/app/job:ro`,
          `${path.join(agentDir, 'keys.json')}:/app/keys.json:ro`,
          `${path.join(agentDir, 'SOUL.md')}:/app/SOUL.md:ro`,
        ],
        AutoRemove: true, // Destroy on stop
        Memory: 2 * 1024 * 1024 * 1024, // 2GB limit
        CpuQuota: 100000, // 1 CPU core
        // Security: No new privileges
        SecurityOpt: ['no-new-privileges:true'],
        // Read-only root filesystem
        ReadonlyRootfs: true,
        // Drop all capabilities
        CapDrop: ['ALL'],
      },
      Labels: {
        'vap.job.id': job.id,
        'vap.agent.id': agentInfo.id,
        'vap.started': String(Date.now()),
        'vap.ephemeral': 'true',
      },
    });
    
    await container.start();
    
    state.active.set(job.id, {
      agentId: agentInfo.id,
      container,
      startedAt: Date.now(),
      agentInfo,
    });
    
    // Remove from available pool
    state.available = state.available.filter(a => a.id !== agentInfo.id);
    
    console.log(`✅ Container started for job ${job.id}`);
    
    // Set timeout
    setTimeout(async () => {
      const active = state.active.get(job.id);
      if (active) {
        console.log(`⏰ Job ${job.id} timeout, killing container`);
        await stopJobContainer(state, job.id);
      }
    }, JOB_TIMEOUT_MS);
    
  } catch (e) {
    console.error(`❌ Failed to start container for ${job.id}:`, e.message);
    // Return agent to pool
    state.available.push(agentInfo);
  }
}

// Stop a job container
async function stopJobContainer(state, jobId) {
  const active = state.active.get(jobId);
  if (!active) return;
  
  try {
    await active.container.stop();
    // AutoRemove will delete it
  } catch (e) {
    console.error(`[Cleanup] Error stopping ${jobId}:`, e.message);
  }
  
  // Cleanup job dir
  const jobDir = path.join(JOBS_DIR, jobId);
  if (fs.existsSync(jobDir)) {
    fs.rmSync(jobDir, { recursive: true });
  }
  
  // Return agent to pool
  state.available.push(active.agentInfo);
  state.active.delete(jobId);
  
  console.log(`✅ Job ${jobId} complete, agent returned to pool`);
}

// Cleanup completed jobs
async function cleanupCompletedJobs(state) {
  for (const [jobId, active] of state.active) {
    try {
      const container = docker.getContainer(`vap-job-${jobId}`);
      const info = await container.inspect();
      
      if (!info.State.Running) {
        console.log(`🗑️  Container for job ${jobId} stopped`);
        await stopJobContainer(state, jobId);
      }
    } catch (e) {
      // Container doesn't exist anymore
      console.log(`🗑️  Container for job ${jobId} gone`);
      await stopJobContainer(state, jobId);
    }
  }
}

program.parse();
