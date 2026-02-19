/**
 * Ephemeral Job Agent Runtime
 * 
 * Runs inside a job-specific container:
 * 1. Connects to VAP
 * 2. Accepts the specific job
 * 3. Does the work
 * 4. Delivers result
 * 5. Exits (container destroyed)
 */

const { VAPAgent } = require('./sdk/dist/index.js');
const fs = require('fs');
const path = require('path');

const API_URL = process.env.VAP_API_URL;
const AGENT_ID = process.env.VAP_AGENT_ID;
const IDENTITY = process.env.VAP_IDENTITY;
const JOB_ID = process.env.VAP_JOB_ID;
const TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '3600000');

const KEYS_FILE = '/app/keys.json';
const SOUL_FILE = '/app/SOUL.md';
const JOB_DIR = '/app/job';

async function main() {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║     Ephemeral Job Agent                 ║`);
  console.log(`║     ${AGENT_ID.padEnd(21)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  
  console.log(`Job ID: ${JOB_ID}`);
  console.log(`Identity: ${IDENTITY}`);
  console.log(`Timeout: ${TIMEOUT_MS / 60000} min\n`);
  
  // Load keys
  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  
  // Load job data
  const job = {
    id: JOB_ID,
    description: fs.readFileSync(path.join(JOB_DIR, 'description.txt'), 'utf8'),
    buyer: fs.readFileSync(path.join(JOB_DIR, 'buyer.txt'), 'utf8'),
    amount: fs.readFileSync(path.join(JOB_DIR, 'amount.txt'), 'utf8'),
    currency: fs.readFileSync(path.join(JOB_DIR, 'currency.txt'), 'utf8'),
  };
  
  console.log('Job Details:');
  console.log(`  Description: ${job.description.substring(0, 100)}...`);
  console.log(`  Buyer: ${job.buyer}`);
  console.log(`  Payment: ${job.amount} ${job.currency}\n`);
  
  // Load SOUL
  let soul = '';
  if (fs.existsSync(SOUL_FILE)) {
    soul = fs.readFileSync(SOUL_FILE, 'utf8');
    console.log(`✓ SOUL loaded (${soul.length} chars)\n`);
  }
  
  // Initialize agent
  const agent = new VAPAgent({
    vapUrl: API_URL,
    wif: keys.wif,
    identityName: IDENTITY,
    iAddress: keys.iAddress,
  });
  
  // Accept the job immediately
  console.log('→ Accepting job...');
  
  const timestamp = Math.floor(Date.now() / 1000);
  const acceptMessage = `VAP-ACCEPT|Job:${job.id}|Buyer:${job.buyer}|Amt:${job.amount} ${job.currency}|Ts:${timestamp}|I accept this job.`;
  
  const { signChallenge } = require('./sdk/dist/identity/signer.js');
  const signature = signChallenge(keys.wif, acceptMessage, keys.iAddress, 'verustest');
  
  await agent.client.acceptJob(job.id, signature, timestamp);
  console.log('✅ Job accepted\n');
  
  // Connect to chat
  await agent.connectChat();
  console.log('✅ Connected to SafeChat\n');
  
  // Do the work (placeholder)
  console.log('→ Processing job...\n');
  
  const result = await processJob(job, soul, agent);
  
  // Deliver result
  console.log('\n→ Delivering result...');
  const deliverSig = signChallenge(
    keys.wif,
    `VAP-DELIVER|Job:${job.id}|Hash:${result.hash}`,
    keys.iAddress,
    'verustest'
  );
  
  await agent.client.deliverJob(job.id, deliverSig, 'Job completed', result.content);
  console.log('✅ Job delivered\n');
  
  // Wait a moment for chat to flush
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('🏁 Job complete. Exiting...');
  process.exit(0);
}

async function processJob(job, soul, agent) {
  // Placeholder: In production, this would:
  // - Use MCP tools
  // - Call LLM
  // - Do actual work
  
  console.log('Working on:', job.description);
  
  // Simulate work
  await new Promise(r => setTimeout(r, 5000));
  
  const content = `Completed: ${job.description}`;
  const hash = require('crypto').createHash('sha256').update(content).digest('hex');
  
  return { content, hash };
}

// Timeout protection
setTimeout(() => {
  console.error('⏰ Job timeout! Exiting.');
  process.exit(1);
}, TIMEOUT_MS);

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
