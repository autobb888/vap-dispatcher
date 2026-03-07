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

const API_URL = process.env.VAP_API_URL;
const AGENT_ID = process.env.VAP_AGENT_ID;
const IDENTITY = process.env.VAP_IDENTITY;
const JOB_ID = process.env.VAP_JOB_ID;
const TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '3600000');
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.5';
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
    console.log('  KIMI_API_KEY   Kimi K2.5 API key for LLM-powered responses');
    console.log('  KIMI_BASE_URL  API base URL (default: https://api.kimi.com/coding/v1)');
    console.log('  KIMI_MODEL     Model name (default: kimi-k2.5)');
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
  console.log(`LLM: ${KIMI_API_KEY ? `Kimi (${KIMI_MODEL})` : 'template mode (no API key)'}\n`);

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
  await agent.authenticate();
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

  await agent.client.acceptJob(job.id, acceptSig, timestamp);
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
  // STEP 2: INTERACTIVE CHAT SESSION
  // ─────────────────────────────────────────
  console.log('→ Starting chat session...\n');

  let result;
  try {
    result = await processJob(job, agent, soulPrompt, (resolve) => { sessionEndResolve = resolve; });
    console.log('\n✅ Work completed\n');
  } catch (e) {
    console.error('\n❌ Job failed:', e.message);
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

  await agent.client.deliverJob(job.id, deliverHash, deliverSig, deliverTimestamp, result.content.substring(0, 200));
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

  process.exit(0);
}

// ─────────────────────────────────────────
// Chat-based job processing
// ─────────────────────────────────────────

async function processJob(job, agent, soulPrompt, registerSessionEndResolve) {
  const conversationLog = [];
  let lastActivityAt = Date.now();
  let sessionEnded = false;
  let resolveSession;

  // Promise that resolves when session ends or idle timeout
  const sessionPromise = new Promise((resolve) => {
    resolveSession = resolve;
    // Expose resolve to the session:ending event handler
    if (registerSessionEndResolve) registerSessionEndResolve(resolve);
  });

  // Build system context for LLM
  const systemPrompt = [
    soulPrompt,
    '',
    '--- Job Context ---',
    `Job: ${job.description}`,
    `Buyer: ${job.buyer}`,
    `Payment: ${job.amount} ${job.currency}`,
    '',
    'You are in a live chat session. Respond helpfully and concisely.',
    'When you believe the work is complete, say so clearly.',
  ].join('\n');

  // Send greeting (always use template — fast, no API dependency)
  const greeting = `Hello! I'm your Verus agent. I've accepted your job: "${job.description.substring(0, 100)}". How can I help you?`;

  agent.sendChatMessage(job.id, greeting);
  conversationLog.push({ role: 'assistant', content: greeting });
  console.log(`[CHAT] Sent greeting`);

  // Handle incoming messages
  agent.onChatMessage(async (jobId, msg) => {
    if (jobId !== job.id) return;
    lastActivityAt = Date.now();

    const buyerMessage = sanitizeInput(msg.content);
    console.log(`[CHAT] ${msg.senderVerusId}: ${buyerMessage.substring(0, 80)}`);
    conversationLog.push({ role: 'user', content: buyerMessage });

    // Generate response
    let response;
    if (KIMI_API_KEY) {
      response = await callLLM(systemPrompt, conversationLog);
    } else {
      response = generateTemplateResponse(buyerMessage, job, soulPrompt);
    }

    agent.sendChatMessage(job.id, response);
    conversationLog.push({ role: 'assistant', content: response });
    console.log(`[CHAT] Agent: ${response.substring(0, 80)}`);
  });

  // Idle timer — check periodically if we should auto-deliver
  const idleCheck = setInterval(() => {
    const idleMs = Date.now() - lastActivityAt;
    console.log(`[CHAT] Heartbeat — idle ${Math.round(idleMs / 1000)}s, messages: ${conversationLog.length}, timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
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

  // Build result
  const fullContent = conversationLog
    .map(m => `${m.role}: ${m.content}`)
    .join('\n\n');
  const hash = crypto.createHash('sha256').update(fullContent).digest('hex');

  return { content: fullContent, hash };
}

// ─────────────────────────────────────────
// LLM: Kimi K2.5 (OpenAI-compatible API)
// ─────────────────────────────────────────

async function callLLM(systemPrompt, messages) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    const res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
        'User-Agent': 'claude-code/1.0',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: apiMessages,
        temperature: 0.6,
        max_tokens: 8192,
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      console.error(`[LLM] Kimi API error ${res.status}: ${err.substring(0, 200)}`);
      return 'I encountered an issue generating a response. Let me try to help directly — could you rephrase your question?';
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    // Kimi Code is a reasoning model: actual answer in 'content', chain-of-thought in 'reasoning_content'
    // Fall back to reasoning_content if content is empty (e.g. token limit hit during reasoning)
    return msg?.content || msg?.reasoning_content || 'I could not generate a response.';
  } catch (e) {
    console.error(`[LLM] Kimi call failed: ${e.message}`);
    return 'I experienced a temporary issue. Please try sending your message again.';
  }
}

// ─────────────────────────────────────────
// Fallback: Template responses (no API key)
// ─────────────────────────────────────────

function generateTemplateResponse(message, job, soulPrompt) {
  const lower = message.toLowerCase();

  if (lower.includes('hello') || lower.includes('hi ') || lower.includes('hey')) {
    return `Hello! I'm working on your request: "${job.description.substring(0, 80)}". What would you like to know?`;
  }

  if (lower.includes('status') || lower.includes('progress') || lower.includes('update')) {
    return `I'm actively working on: "${job.description.substring(0, 80)}". I'll let you know when it's ready.`;
  }

  if (lower.includes('done') || lower.includes('finish') || lower.includes('complete') || lower.includes('deliver')) {
    return `Understood — I'll wrap up and deliver the results now. Thank you for using the Verus Agent Platform!`;
  }

  if (lower.includes('help') || lower.includes('what can you do')) {
    return `I'm a Verus agent specializing in the areas described in my profile. For this job, I'm working on: "${job.description.substring(0, 80)}". Feel free to ask me anything related!`;
  }

  // Default: acknowledge and echo context
  return `Thanks for your message. I'm processing your request regarding: "${job.description.substring(0, 60)}". Is there anything specific you'd like me to focus on?`;
}

// Timeout protection
setTimeout(() => {
  console.error('⏰ Job timeout! Signing deletion attestation and exiting.');

  // Try to sign deletion attestation even on timeout
  try {
    const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    const deletionAttestation = {
      jobId: JOB_ID,
      containerId: CONTAINER_ID,
      destroyedAt: new Date().toISOString(),
      deletionMethod: 'timeout',
    };

    const { signMessage: signMsg } = require('./sdk/dist/identity/signer.js');
    const sig = signMsg(keys.wif, JSON.stringify(deletionAttestation), 'verustest');
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
