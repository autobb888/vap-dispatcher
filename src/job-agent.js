/**
 * Ephemeral Job Agent Runtime with Privacy Attestation
 *
 * Signs a deletion attestation when the container is destroyed
 * (destruction timestamp, data volumes). Submitted to the platform
 * for privacy verification.
 */

const { VAPAgent } = require('./sdk/dist/index.js');
const { signMessage } = require('./sdk/dist/identity/signer.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExecutor, EXECUTOR_TYPE } = require('./executors/index.js');

const API_URL = process.env.VAP_API_URL;
const AGENT_ID = process.env.VAP_AGENT_ID;
const IDENTITY = process.env.VAP_IDENTITY;
const JOB_ID = process.env.VAP_JOB_ID;
const TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '3600000');
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '120000'); // 2 min idle → deliver

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

// Retry helper with exponential backoff for transient API failures
async function withRetry(fn, label, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLast = attempt === maxAttempts;
      console.error(`[RETRY] ${label} attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
      if (isLast) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
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
    console.log('\nOptional:');
    console.log('  VAP_EXECUTOR       Executor type: local-llm (default), webhook, langserve, langgraph, a2a, mcp');
    console.log('  KIMI_API_KEY       Kimi K2.5 API key (local-llm executor)');
    console.log('  KIMI_BASE_URL      API base URL (default: https://api.kimi.com/coding/v1)');
    console.log('  KIMI_MODEL         Model name (default: kimi-k2.5)');
    console.log('  VAP_EXECUTOR_URL   Endpoint URL (webhook, langserve, langgraph, a2a)');
    console.log('  VAP_EXECUTOR_AUTH  Authorization header');
    console.log('  VAP_EXECUTOR_ASSISTANT  LangGraph assistant ID (default: agent)');
    console.log('  VAP_MCP_COMMAND    MCP server command (mcp executor, stdio)');
    console.log('  VAP_MCP_URL        MCP server URL (mcp executor, HTTP)');
    console.log('  IDLE_TIMEOUT_MS    Idle timeout before auto-deliver (default: 120000)');
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
  console.log(`Timeout: ${TIMEOUT_MS / 60000} min`);
  console.log(`Executor: ${EXECUTOR_TYPE}\n`);

  // Load keys
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));

  // Load SOUL personality
  let soulPrompt = '';
  try {
    soulPrompt = fs.readFileSync(SOUL_FILE, 'utf8').trim();
  } catch {
    soulPrompt = 'You are a helpful AI agent on the Verus Agent Platform.';
  }

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

  // Establish authenticated API session via SDK login
  await withRetry(() => agent.authenticate(), 'authenticate');
  console.log('✅ Agent logged in\n');

  const creationTime = new Date().toISOString();

  // ─────────────────────────────────────────
  // STEP 1: ACCEPT JOB (sign + submit)
  // ─────────────────────────────────────────
  console.log('→ Accepting job...');

  const timestamp = Math.floor(Date.now() / 1000);

  // Fetch canonical job data and build acceptance message
  const fullJob = await agent.client.getJob(job.id);
  const acceptMessage = `VAP-ACCEPT|Job:${fullJob.jobHash}|Buyer:${fullJob.buyerVerusId}|Amt:${fullJob.amount} ${fullJob.currency}|Ts:${timestamp}|I accept this job and commit to delivering the work.`;
  const acceptSig = signMessage(keys.wif, acceptMessage, 'verustest');

  await withRetry(() => agent.client.acceptJob(job.id, acceptSig, timestamp), 'acceptJob');
  console.log('✅ Job accepted\n');

  // Connect to chat
  await agent.connectChat();
  console.log('✅ Connected to SafeChat\n');

  // Explicitly join this job's chat room
  agent.joinJobChat(job.id);
  console.log(`[CHAT] Joined job room: ${job.id}`);

  // Debug: log ALL chat events to help diagnose message delivery
  agent.on('chat:message', (msg) => {
    console.log(`[CHAT-DEBUG] Received message event — jobId=${msg.jobId} sender=${msg.senderVerusId} content="${(msg.content || '').substring(0, 80)}"`);
  });

  // Prevent VAPAgent's built-in autoDeliver (which has wrong delivery format)
  // by setting a custom handler that we control
  agent.setHandler({
    onSessionEnding: async (sessionJob, reason, requestedBy) => {
      console.log(`[SESSION] Session ending for job ${sessionJob.id} — reason: ${reason}, requestedBy: ${requestedBy}`);
      if (sessionJob.id === job.id && sessionEndResolve) {
        agent.sendChatMessage(job.id, 'Session ended — wrapping up and delivering results. Thank you!');
        sessionEndResolve('session-ended');
      }
    },
  });

  // Session-end signal: when buyer or platform ends the session, we resolve processJob
  let sessionEndResolve = null;

  // ─────────────────────────────────────────
  // STEP 2: INTERACTIVE CHAT SESSION (Executor pattern — M6)
  // ─────────────────────────────────────────
  console.log(`→ Starting chat session (executor: ${EXECUTOR_TYPE})...\n`);

  const executor = createExecutor();
  let result;
  try {
    result = await processJob(job, agent, soulPrompt, executor, (resolve) => { sessionEndResolve = resolve; });
    console.log('\n✅ Work completed\n');
  } catch (e) {
    console.error('\n❌ Job failed:', e.message);
    await executor.cleanup().catch(() => {});
    result = { error: e.message, content: 'Job failed: ' + e.message };
  }

  // ─────────────────────────────────────────
  // STEP 3: DELIVER RESULT
  // ─────────────────────────────────────────
  console.log('→ Delivering result...');
  const deliverTimestamp = Math.floor(Date.now() / 1000);
  const deliverHash = result.hash || 'failed';
  const deliverMessage = `VAP-DELIVER|Job:${fullJob.jobHash}|Delivery:${deliverHash}|Ts:${deliverTimestamp}|I have delivered the work for this job.`;
  const deliverSig = signMessage(keys.wif, deliverMessage, 'verustest');

  await withRetry(
    () => agent.client.deliverJob(job.id, deliverHash, deliverSig, deliverTimestamp, result.content.substring(0, 200)),
    'deliverJob',
    { maxAttempts: 5, baseDelayMs: 2000 }
  );
  console.log('✅ Job delivered\n');

  // Wait for chat to flush
  await new Promise(r => setTimeout(r, 3000));

  // ─────────────────────────────────────────
  // STEP 4: DELETION ATTESTATION
  // ─────────────────────────────────────────
  console.log('→ Signing deletion attestation...');

  const deletionTime = new Date().toISOString();
  const attestTimestamp = Math.floor(Date.now() / 1000);

  // Use platform's canonical deletion attestation flow
  try {
    const { message: attestMessage, timestamp: attestTs } =
      await agent.client.getDeletionAttestationMessage(JOB_ID, attestTimestamp);
    const attestSig = signMessage(keys.wif, attestMessage, 'verustest');

    // Save attestation locally
    fs.writeFileSync(
      path.join(JOB_DIR, 'deletion-attestation.json'),
      JSON.stringify({ jobId: JOB_ID, message: attestMessage, signature: attestSig, timestamp: attestTs }, null, 2)
    );

    const result = await agent.client.submitDeletionAttestation(JOB_ID, attestSig, attestTs);
    console.log(`✅ Deletion attestation submitted (verified: ${result.signatureVerified})\n`);
  } catch (e) {
    console.log('⚠️  Could not submit attestation:', e.message);
  }

  console.log('🏁 Job complete with privacy attestation. Container will be destroyed.');
  console.log('');
  console.log('Privacy Summary:');
  console.log(`  Creation: ${creationTime}`);
  console.log(`  Deletion: ${deletionTime}`);
  console.log(`  Duration: ${(new Date(deletionTime) - new Date(creationTime)) / 1000}s`);
  console.log(`  Container: ${CONTAINER_ID.substring(0, 12)}`);
  console.log('');

  // J5: Clean disconnect — close socket.io and stop polling before exit
  agent.stop();
  process.exit(0);
}

// ─────────────────────────────────────────
// Chat-based job processing (M6: Executor pattern)
// ─────────────────────────────────────────

async function processJob(job, agent, soulPrompt, executor, registerSessionEndResolve) {
  let lastActivityAt = Date.now();
  let sessionEnded = false;
  let resolveSession;
  let messageCount = 0;

  // Promise that resolves when session ends or idle timeout
  const sessionPromise = new Promise((resolve) => {
    resolveSession = resolve;
    if (registerSessionEndResolve) registerSessionEndResolve(resolve);
  });

  // Initialize executor (sends greeting, sets up state)
  await executor.init(job, agent, soulPrompt);

  // Handle incoming messages — delegate to executor
  agent.onChatMessage(async (jobId, msg) => {
    if (jobId !== job.id) return;
    lastActivityAt = Date.now();
    messageCount++;

    const buyerMessage = sanitizeInput(msg.content);
    console.log(`[CHAT] ${msg.senderVerusId}: ${buyerMessage.substring(0, 80)}`);

    try {
      const response = await executor.handleMessage(buyerMessage, {
        senderVerusId: msg.senderVerusId,
        jobId: msg.jobId,
      });

      agent.sendChatMessage(job.id, response);
      console.log(`[CHAT] Agent: ${response.substring(0, 80)}`);
    } catch (e) {
      console.error(`[CHAT] Executor error: ${e.message}`);
      agent.sendChatMessage(job.id, 'I experienced an issue processing your message. Please try again.');
    }
  });

  // Idle timer — check periodically if we should auto-deliver
  const idleCheck = setInterval(() => {
    const idleMs = Date.now() - lastActivityAt;
    console.log(`[CHAT] Heartbeat — idle ${Math.round(idleMs / 1000)}s, messages: ${messageCount}, timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
    if (idleMs >= IDLE_TIMEOUT_MS && !sessionEnded) {
      console.log(`[CHAT] Idle for ${Math.round(idleMs / 1000)}s — auto-delivering`);
      agent.sendChatMessage(job.id, 'Session idle — delivering results. Thank you!');
      sessionEnded = true;
      resolveSession();
    }
  }, 10000);

  // Wait for session end or idle timeout
  await sessionPromise;
  clearInterval(idleCheck);

  // Finalize executor — get deliverable
  return await executor.finalize();
}

// Timeout protection (J4: also submit attestation to API, not just disk)
setTimeout(async () => {
  console.error('⏰ Job timeout! Signing deletion attestation and exiting.');

  try {
    const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    const attestTimestamp = Math.floor(Date.now() / 1000);

    // Try to use the platform's canonical attestation flow (J4)
    try {
      const { VAPAgent } = require('./sdk/dist/index.js');
      const agent = new VAPAgent({
        vapUrl: API_URL,
        wif: keys.wif,
        identityName: IDENTITY,
        iAddress: keys.iAddress,
      });
      await agent.authenticate();
      const { message: attestMessage } = await agent.client.getDeletionAttestationMessage(JOB_ID, attestTimestamp);
      const { signMessage: signMsg } = require('./sdk/dist/identity/signer.js');
      const attestSig = signMsg(keys.wif, attestMessage, 'verustest');

      fs.writeFileSync(
        path.join(JOB_DIR, 'deletion-attestation-timeout.json'),
        JSON.stringify({ jobId: JOB_ID, message: attestMessage, signature: attestSig, timestamp: attestTimestamp }, null, 2)
      );

      const result = await agent.client.submitDeletionAttestation(JOB_ID, attestSig, attestTimestamp);
      console.log(`✅ Timeout attestation submitted (verified: ${result.signatureVerified})`);
      agent.stop();
    } catch (apiErr) {
      // Fallback: sign locally and save to disk only
      console.error('⚠️  Could not submit attestation to API:', apiErr.message);
      const deletionAttestation = {
        jobId: JOB_ID,
        containerId: CONTAINER_ID,
        destroyedAt: new Date().toISOString(),
        deletionMethod: 'timeout',
      };
      const { signMessage: signMsg } = require('./sdk/dist/identity/signer.js');
      deletionAttestation.signature = signMsg(keys.wif, JSON.stringify(deletionAttestation), 'verustest');
      fs.writeFileSync(
        path.join(JOB_DIR, 'deletion-attestation-timeout.json'),
        JSON.stringify(deletionAttestation, null, 2)
      );
    }
  } catch (e) {
    console.error('Could not sign timeout attestation:', e.message);
  }

  process.exit(1);
}, TIMEOUT_MS);

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
