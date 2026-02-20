/**
 * Ephemeral Job Agent Runtime with Privacy Attestation
 * 
 * Signs attestations:
 * 1. CREATION: When container starts (container ID, timestamp, job hash)
 * 2. DELETION: When container destroyed (destruction timestamp, data volumes)
 * 
 * These are submitted to the platform for privacy verification.
 */

const { VAPAgent } = require('./sdk/dist/index.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_URL = process.env.VAP_API_URL;
const AGENT_ID = process.env.VAP_AGENT_ID;
const IDENTITY = process.env.VAP_IDENTITY;
const JOB_ID = process.env.VAP_JOB_ID;
const TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '3600000');

const KEYS_FILE = '/app/keys.json';
const SOUL_FILE = '/app/SOUL.md';
const JOB_DIR = '/app/job';

// Container metadata (from Docker labels)
const CONTAINER_ID = process.env.HOSTNAME || 'unknown'; // Docker sets HOSTNAME to container ID

// P2-1: Input sanitization helper
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .substring(0, 10000); // Limit length to prevent DoS
}

async function main() {
  // Check for required environment variables
  if (!AGENT_ID || !JOB_ID || !IDENTITY) {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║     VAP Job Agent Runtime               ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    console.log('Usage: docker run --rm -e VAP_AGENT_ID=<id> -e VAP_JOB_ID=<job> -e VAP_IDENTITY=<identity> vap/job-agent\n');
    console.log('Required environment variables:');
    console.log('  VAP_AGENT_ID     Agent identifier (e.g., agent-1)');
    console.log('  VAP_JOB_ID       Job ID from platform');
    console.log('  VAP_IDENTITY     Verus identity (e.g., ari1.agentplatform@)');
    console.log('  VAP_API_URL      API endpoint (default: https://api.autobb.app)');
    console.log('\nThis container is spawned by vap-dispatcher for each job.');
    process.exit(0);
  }

  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║     Ephemeral Job Agent (Privacy)       ║`);
  console.log(`║     ${AGENT_ID.padEnd(21)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  
  console.log(`Job ID: ${JOB_ID}`);
  console.log(`Identity: ${IDENTITY}`);
  console.log(`Container: ${CONTAINER_ID.substring(0, 12)}`);
  console.log(`Timeout: ${TIMEOUT_MS / 60000} min\n`);
  
  // Load keys
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  
  // Load job data with input validation (P2-1)
  const job = {
    id: JOB_ID,
    description: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'description.txt'), 'utf8')),
    buyer: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'buyer.txt'), 'utf8')),
    amount: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'amount.txt'), 'utf8')),
    currency: sanitizeInput(fs.readFileSync(path.join(JOB_DIR, 'currency.txt'), 'utf8')),
  };
  
  console.log('Job Details:');
  console.log(`  Description: ${job.description.substring(0, 100)}...`);
  console.log(`  Buyer: ${job.buyer}`);
  console.log(`  Payment: ${job.amount} ${job.currency}\n`);
  
  // Initialize agent
  const agent = new VAPAgent({
    vapUrl: API_URL,
    wif: keys.wif,
    identityName: IDENTITY,
    iAddress: keys.iAddress,
  });

  // Establish authenticated API session before job actions
  await authenticateAgent(agent, keys);
  console.log('✅ Agent logged in\n');
  
  // ─────────────────────────────────────────
  // STEP 1: CREATION ATTESTATION
  // ─────────────────────────────────────────
  console.log('→ Signing creation attestation...');
  
  const creationTime = new Date().toISOString();
  // P1-2: Fix job hash construction with structured JSON
  const jobHash = crypto.createHash('sha256')
    .update(JSON.stringify({
      jobId: JOB_ID,
      description: job.description,
      buyer: job.buyer,
      amount: job.amount,
      currency: job.currency,
      timestamp: creationTime,
    }))
    .digest('hex');
  
  const creationAttestation = {
    type: 'container:created',
    jobId: JOB_ID,
    containerId: CONTAINER_ID,
    agentId: AGENT_ID,
    identity: IDENTITY,
    createdAt: creationTime,
    jobHash: jobHash,
    ephemeral: true,
    memoryLimit: '2GB',
    cpuLimit: '1 core',
    privacyTier: 'ephemeral-container',
  };
  
  const creationMessage = JSON.stringify(creationAttestation);
  const { signChallenge, signMessage } = require('./sdk/dist/identity/signer.js');
  const creationSig = signChallenge(keys.wif, creationMessage, keys.iAddress, 'verustest');
  
  creationAttestation.signature = creationSig;
  
  // Save to job dir for later
  fs.writeFileSync(
    path.join(JOB_DIR, 'creation-attestation.json'),
    JSON.stringify(creationAttestation, null, 2)
  );
  
  console.log('✅ Creation attestation signed\n');
  
  // ─────────────────────────────────────────
  // STEP 2: ACCEPT JOB
  // ─────────────────────────────────────────
  console.log('→ Accepting job...');
  
  const timestamp = Math.floor(Date.now() / 1000);

  // Fetch canonical job data and match SDK acceptance message format exactly
  const fullJob = await agent.client.getJob(job.id);
  const acceptMessage = `VAP-ACCEPT|Job:${fullJob.jobHash}|Buyer:${fullJob.buyerVerusId}|Amt:${fullJob.amount} ${fullJob.currency}|Ts:${timestamp}|I accept this job and commit to delivering the work.`;

  const acceptSig = signMessage(keys.wif, acceptMessage, 'verustest');

  await agent.client.acceptJob(job.id, acceptSig, timestamp);
  console.log('✅ Job accepted\n');
  
  // Connect to chat
  await agent.connectChat();
  console.log('✅ Connected to SafeChat\n');
  
  // ─────────────────────────────────────────
  // STEP 3: DO THE WORK
  // ─────────────────────────────────────────
  console.log('→ Processing job...\n');
  
  let result;
  try {
    result = await processJob(job, agent);
    console.log('\n✅ Work completed\n');
  } catch (e) {
    console.error('\n❌ Job failed:', e.message);
    result = { error: e.message, content: 'Job failed: ' + e.message };
  }
  
  // ─────────────────────────────────────────
  // STEP 4: DELIVER RESULT
  // ─────────────────────────────────────────
  console.log('→ Delivering result...');
  const deliverSig = signMessage(
    keys.wif,
    `VAP-DELIVER|Job:${job.id}|Hash:${result.hash || 'failed'}`,
    'verustest'
  );
  
  await agent.client.deliverJob(job.id, deliverSig, result.content.substring(0, 200), result.content);
  console.log('✅ Job delivered\n');
  
  // Wait for chat to flush
  await new Promise(r => setTimeout(r, 5000));
  
  // ─────────────────────────────────────────
  // STEP 5: DELETION ATTESTATION
  // ─────────────────────────────────────────
  console.log('→ Signing deletion attestation...');
  
  const deletionTime = new Date().toISOString();
  
  const deletionAttestation = {
    type: 'container:destroyed',
    jobId: JOB_ID,
    containerId: CONTAINER_ID,
    agentId: AGENT_ID,
    identity: IDENTITY,
    createdAt: creationTime,
    destroyedAt: deletionTime,
    jobHash: jobHash,
    dataVolumes: ['/app/job', '/tmp', '/var/tmp'],
    deletionMethod: 'container-auto-remove',
    ephemeral: true,
    privacyAttestation: true,
  };
  
  const deletionMessage = JSON.stringify(deletionAttestation);
  const deletionSig = signChallenge(keys.wif, deletionMessage, keys.iAddress, 'verustest');
  
  deletionAttestation.signature = deletionSig;
  
  // Save attestation
  fs.writeFileSync(
    path.join(JOB_DIR, 'deletion-attestation.json'),
    JSON.stringify(deletionAttestation, null, 2)
  );
  
  // Submit to platform
  try {
    await agent.client.submitAttestation({
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      creationAttestation,
      deletionAttestation,
      attestedBy: IDENTITY,
      attestedAt: deletionTime,
    });
    console.log('✅ Deletion attestation submitted to platform\n');
  } catch (e) {
    console.log('⚠️  Could not submit attestation (optional feature):', e.message);
  }
  
  console.log('🏁 Job complete with privacy attestation. Container will be destroyed.');
  console.log('');
  console.log('Privacy Summary:');
  console.log(`  Creation: ${creationTime}`);
  console.log(`  Deletion: ${deletionTime}`);
  console.log(`  Duration: ${(new Date(deletionTime) - new Date(creationTime)) / 1000}s`);
  console.log(`  Container: ${CONTAINER_ID.substring(0, 12)}`);
  console.log(`  Job Hash: ${jobHash.substring(0, 16)}...`);
  console.log('');
  
  process.exit(0);
}

async function authenticateAgent(agent, keys) {
  const { signMessage } = require('./sdk/dist/identity/signer.js');

  const challengeRes = await agent.client.getAuthChallenge();
  const signature = signMessage(keys.wif, challengeRes.challenge, 'verustest');

  const loginRes = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challengeRes.challengeId,
      verusId: IDENTITY,
      signature,
    }),
  });

  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(`Login failed: ${body}`);
  }

  const setCookie = loginRes.headers.get('set-cookie') || '';
  const match = setCookie.match(/verus_session=([^;]+)/);
  if (!match) {
    throw new Error('Login succeeded but no verus_session cookie returned');
  }

  agent.client.setSessionToken(match[1]);
}

async function processJob(job, agent) {
  // In production: Use MCP tools, call LLM, etc.
  console.log('Working on:', job.description);
  
  // Simulate work
  await new Promise(r => setTimeout(r, 5000));
  
  const content = `Completed: ${job.description}`;
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  
  return { content, hash };
}

// Timeout protection
setTimeout(() => {
  console.error('⏰ Job timeout! Signing deletion attestation and exiting.');
  
  // Try to sign deletion attestation even on timeout
  try {
    const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    const deletionAttestation = {
      type: 'container:destroyed:timeout',
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      destroyedAt: new Date().toISOString(),
      reason: 'timeout',
    };
    
    const { signChallenge } = require('./sdk/dist/identity/signer.js');
    const sig = signChallenge(keys.wif, JSON.stringify(deletionAttestation), keys.iAddress, 'verustest');
    deletionAttestation.signature = sig;
    
    fs.writeFileSync(
      path.join(JOB_DIR, 'deletion-attestation-timeout.json'),
      JSON.stringify(deletionAttestation, null, 2)
    );
  } catch (e) {
    console.error('Could not sign timeout attestation:', e.message);
  }
  
  process.exit(1);
}, TIMEOUT_MS);

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
