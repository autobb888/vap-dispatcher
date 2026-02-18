/**
 * Rate Limiter — controls job acceptance rate and ghost job detection
 */
var config = require('./config');

var acceptTimestamps = []; // timestamps of recent accepts
var ghostTimers = new Map(); // jobId → timer

function canAcceptJob() {
  var now = Date.now();
  // Clean old timestamps (older than 1 minute)
  acceptTimestamps = acceptTimestamps.filter(function(ts) {
    return (now - ts) < 60000;
  });
  return acceptTimestamps.length < config.maxAcceptsPerMinute;
}

function recordAccept() {
  acceptTimestamps.push(Date.now());
}

function startGhostTimer(jobId, onGhostTimeout) {
  if (ghostTimers.has(jobId)) return;
  
  var timer = setTimeout(function() {
    ghostTimers.delete(jobId);
    console.log('[RATE] Ghost timeout for job ' + jobId.slice(0, 8) + ' — no buyer message in ' + (config.ghostTimeout / 1000) + 's');
    if (onGhostTimeout) onGhostTimeout(jobId);
  }, config.ghostTimeout);
  
  ghostTimers.set(jobId, timer);
}

function clearGhostTimer(jobId) {
  var timer = ghostTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    ghostTimers.delete(jobId);
  }
}

function canQueueJob(currentQueueSize) {
  return currentQueueSize < config.maxQueuedJobs;
}

module.exports = {
  canAcceptJob: canAcceptJob,
  recordAccept: recordAccept,
  startGhostTimer: startGhostTimer,
  clearGhostTimer: clearGhostTimer,
  canQueueJob: canQueueJob,
};
