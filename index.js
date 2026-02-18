/**
 * VAP Dispatcher — Ephemeral Agent Orchestrator
 * 
 * Monitors VAP marketplace for jobs, spins up Docker containers per job,
 * routes SafeChat messages to containers via HTTP, manages lifecycle.
 * 
 * Usage: node dispatcher/index.js
 * 
 * Required env vars:
 *   NVIDIA_API_KEY      — For LLM calls (held by proxy, never in containers)
 *   OPENROUTER_API_KEY  — For embeddings (held by proxy, never in containers)
 * 
 * Optional env vars: see dispatcher/config.js
 */
var config = require('./config');
var vapClient = require('./vap-client');
var safechat = require('./safechat');
var containerMgr = require('./container-mgr');
var apiProxy = require('./api-proxy');
var chatLogger = require('./chat-logger');
var rateLimiter = require('./rate-limiter');
var crypto = require('crypto');

// State
var processedJobs = new Set();  // Jobs we've already seen
var activeJobs = new Map();     // jobId → { port, containerId, token, status }
var jobQueue = [];              // Jobs waiting for a free container slot

// ── Message Handler ────────────────────────────────────────────────

async function handleMessage(jobId, content, senderVerusId) {
  // Clear ghost timer — buyer is active
  rateLimiter.clearGhostTimer(jobId);

  var job = activeJobs.get(jobId);
  
  if (!job) {
    // Job not yet containerized — might be queued or just accepted
    if (job && job.status === 'queued') {
      safechat.sendMessage(jobId, 'Your request is queued. Please wait while I set up your session...');
      return;
    }
    // Try to spin up on demand
    console.log('[DISPATCH] Message for unknown job ' + jobId.slice(0, 8) + ' — attempting container start');
    var started = await spinUpContainer(jobId);
    if (!started) {
      safechat.sendMessage(jobId, 'Sorry, all agent slots are currently busy. Your request has been queued.');
      return;
    }
    job = activeJobs.get(jobId);
  }

  if (job.status === 'starting') {
    safechat.sendMessage(jobId, 'Agent is starting up, please wait a moment...');
    return;
  }

  if (job.status !== 'ready') {
    safechat.sendMessage(jobId, 'Agent is not ready yet. Please try again in a moment.');
    return;
  }

  // Generate nonce for request tracking
  var nonce = crypto.randomBytes(8).toString('hex');

  // Log the user message (authoritative)
  chatLogger.logUserMessage(jobId, content, senderVerusId, nonce);

  try {
    console.log('[DISPATCH] Forwarding to container on port ' + job.port);
    var response = await containerMgr.sendToContainer(job.port, content, nonce);

    // Truncate if needed
    if (response.length > 3900) {
      response = response.slice(0, 3900) + '\n\n[Response truncated]';
    }

    // Log the response (authoritative)
    chatLogger.logAssistantMessage(jobId, response, nonce, job.port);

    // Send back to SafeChat
    safechat.sendMessage(jobId, response);
    console.log('[DISPATCH] 📤 Replied (' + response.length + ' chars) for job ' + jobId.slice(0, 8));
  } catch (err) {
    console.error('[DISPATCH] Error from container:', err.message);
    chatLogger.logEvent(jobId, 'error', { message: err.message, nonce: nonce });
    safechat.sendMessage(jobId, 'Sorry, I encountered an error processing your request. Please try again.');
  }
}

// ── Container Lifecycle ────────────────────────────────────────────

async function spinUpContainer(jobId) {
  // Register with active jobs as "starting"
  activeJobs.set(jobId, { status: 'starting', port: null, containerId: null, token: null });
  
  chatLogger.logEvent(jobId, 'container.starting', {});

  var result = await containerMgr.startContainer(jobId);
  if (!result) {
    activeJobs.delete(jobId);
    return false;
  }

  // Register token with API proxy
  apiProxy.registerToken(result.token, jobId);

  // Update state
  activeJobs.set(jobId, {
    status: 'starting',
    port: result.port,
    containerId: result.containerId,
    token: result.token,
  });

  // Wait for health
  var healthy = await containerMgr.waitForHealth(result.port, 30000);
  if (!healthy) {
    console.error('[DISPATCH] Container failed health check for job ' + jobId.slice(0, 8));
    await teardownContainer(jobId);
    return false;
  }

  activeJobs.set(jobId, {
    status: 'ready',
    port: result.port,
    containerId: result.containerId,
    token: result.token,
  });

  chatLogger.logEvent(jobId, 'container.ready', { port: result.port, containerId: result.containerId });
  console.log('[DISPATCH] ✅ Container ready for job ' + jobId.slice(0, 8) + ' on port ' + result.port);

  // Start ghost timer
  rateLimiter.startGhostTimer(jobId, function(expiredJobId) {
    console.log('[DISPATCH] Ghost job ' + expiredJobId.slice(0, 8) + ' — tearing down');
    teardownContainer(expiredJobId);
  });

  return true;
}

async function teardownContainer(jobId) {
  var job = activeJobs.get(jobId);
  if (!job) return;

  rateLimiter.clearGhostTimer(jobId);

  // Log hash before teardown
  var logHash = chatLogger.getLogHash(jobId);
  chatLogger.logEvent(jobId, 'container.destroying', { logHash: logHash });

  if (job.token) {
    apiProxy.revokeToken(job.token);
  }

  if (job.port) {
    await containerMgr.destroyContainer(job.port);
  }

  chatLogger.logEvent(jobId, 'container.destroyed', {});
  activeJobs.delete(jobId);

  // Process queue
  processQueue();
}

// ── Job Polling ────────────────────────────────────────────────────

async function pollJobs() {
  try {
    var jobs = await vapClient.getRequestedJobs();
    
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      if (processedJobs.has(job.id)) continue;
      processedJobs.add(job.id);

      console.log('[DISPATCH] New job request: ' + (job.description || '').slice(0, 60));
      console.log('           Amount: ' + job.amount + ' ' + job.currency + ' | ID: ' + job.id.slice(0, 8));

      // Rate limit check
      if (!rateLimiter.canAcceptJob()) {
        console.log('[DISPATCH] Rate limited — skipping job ' + job.id.slice(0, 8));
        continue;
      }

      // Accept the job
      var accepted = await vapClient.acceptJob(job.id);
      if (!accepted) continue;
      rateLimiter.recordAccept();

      // Join SafeChat room
      safechat.joinRoom(job.id);

      // Try to spin up container
      var port = containerMgr.getPortForJob(job.id);
      if (!port && containerMgr.getActiveContainerCount() < (config.portRangeEnd - config.portRangeStart + 1)) {
        await spinUpContainer(job.id);
      } else if (!port) {
        // Queue it
        if (rateLimiter.canQueueJob(jobQueue.length)) {
          jobQueue.push(job.id);
          activeJobs.set(job.id, { status: 'queued' });
          console.log('[DISPATCH] Job ' + job.id.slice(0, 8) + ' queued (' + jobQueue.length + ' in queue)');
          safechat.sendMessage(job.id, 'All agent slots are busy. You are #' + jobQueue.length + ' in queue. Please wait...');
        } else {
          console.log('[DISPATCH] Queue full — cannot accept job ' + job.id.slice(0, 8));
        }
      }
    }
  } catch (e) {
    console.error('[DISPATCH] Poll error:', e.message);
  }
}

function processQueue() {
  if (jobQueue.length === 0) return;
  
  var maxSlots = config.portRangeEnd - config.portRangeStart + 1;
  if (containerMgr.getActiveContainerCount() >= maxSlots) return;

  var jobId = jobQueue.shift();
  console.log('[DISPATCH] Dequeuing job ' + jobId.slice(0, 8) + ' (' + jobQueue.length + ' remaining)');
  safechat.sendMessage(jobId, 'Your session is starting now...');
  spinUpContainer(jobId);
}

// ── Rejoin Active Jobs ─────────────────────────────────────────────

async function rejoinActiveJobs() {
  try {
    var jobs = await vapClient.getActiveJobs();
    for (var i = 0; i < jobs.length; i++) {
      safechat.joinRoom(jobs[i].id);
      processedJobs.add(jobs[i].id);
    }
    if (jobs.length > 0) {
      console.log('[DISPATCH] Rejoined ' + jobs.length + ' active job rooms');
    }
  } catch (e) {
    console.error('[DISPATCH] Error rejoining active jobs:', e.message);
  }
}

// ── Lifetime Enforcement ───────────────────────────────────────────

function checkLifetimes() {
  containerMgr.enforceLifetimes(function(jobId) {
    safechat.sendMessage(jobId, 'Session time limit reached. Thank you for using Ari2!');
    teardownContainer(jobId);
  });
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  VAP Dispatcher — Ephemeral Agents   ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('  Identity:  ' + config.vapIdentity);
  console.log('  API:       ' + config.vapApi);
  console.log('  Image:     ' + config.dockerImage);
  console.log('  Ports:     ' + config.portRangeStart + '-' + config.portRangeEnd);
  console.log('  Proxy:     127.0.0.1:' + config.proxyPort);
  console.log('  Jobs dir:  ' + config.jobsPath);
  console.log('  Wiki:      ' + config.wikiPath);
  console.log('  Max life:  ' + (config.containerMaxLifetime / 60000) + ' min');
  console.log('  Poll:      ' + (config.pollInterval / 1000) + 's');
  console.log('');

  // Validate required keys
  if (!config.nvidiaApiKey) {
    console.error('ERROR: Set NVIDIA_API_KEY env var');
    process.exit(1);
  }
  if (!config.openrouterApiKey) {
    console.error('ERROR: Set OPENROUTER_API_KEY env var');
    process.exit(1);
  }

  // Ensure jobs directory exists
  var fs = require('fs');
  if (!fs.existsSync(config.jobsPath)) {
    fs.mkdirSync(config.jobsPath, { recursive: true });
  }
  if (!fs.existsSync(config.tmpConfigBase)) {
    fs.mkdirSync(config.tmpConfigBase, { recursive: true });
  }

  // Initialize
  vapClient.init();

  // Start API proxy
  await apiProxy.start();

  // Login to VAP
  await vapClient.login();

  // Connect to SafeChat
  safechat.setMessageHandler(handleMessage);
  await safechat.connect(vapClient);

  // Rejoin active job rooms
  await rejoinActiveJobs();

  // Start polling
  await pollJobs();
  setInterval(pollJobs, config.pollInterval);

  // Lifetime enforcement every 60s
  setInterval(checkLifetimes, 60000);

  console.log('[DISPATCH] ✅ Dispatcher running. Waiting for jobs...');
}

// Graceful shutdown
process.on('SIGINT', async function() {
  console.log('\n[DISPATCH] Shutting down...');
  
  // Destroy all containers
  for (var entry of activeJobs.entries()) {
    var jobId = entry[0];
    var job = entry[1];
    if (job.port) {
      console.log('[DISPATCH] Stopping container for job ' + jobId.slice(0, 8));
      await containerMgr.destroyContainer(job.port);
    }
  }

  apiProxy.stop();
  console.log('[DISPATCH] Goodbye!');
  process.exit(0);
});

main().catch(function(e) {
  console.error('Fatal:', e.message);
  process.exit(1);
});
