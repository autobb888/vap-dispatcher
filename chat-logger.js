/**
 * Chat Logger — dispatcher-side authoritative chat logging
 * 
 * Writes one JSONL file per job in the jobs directory.
 * This is the authoritative record (container logs are supplementary).
 */
var fs = require('fs');
var path = require('path');
var config = require('./config');

function ensureJobDir(jobId) {
  var dir = path.join(config.jobsPath, jobId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function logMessage(jobId, role, content, metadata) {
  var dir = ensureJobDir(jobId);
  var logFile = path.join(dir, 'dispatcher-log.jsonl');
  
  var entry = {
    ts: new Date().toISOString(),
    role: role,
    content: content,
  };
  
  if (metadata) {
    Object.keys(metadata).forEach(function(k) {
      entry[k] = metadata[k];
    });
  }

  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

function logUserMessage(jobId, content, senderVerusId, nonce) {
  logMessage(jobId, 'user', content, {
    sender: senderVerusId,
    nonce: nonce,
  });
}

function logAssistantMessage(jobId, content, nonce, containerPort) {
  logMessage(jobId, 'assistant', content, {
    nonce: nonce,
    containerPort: containerPort,
    model: config.model,
  });
}

function logEvent(jobId, eventType, data) {
  logMessage(jobId, 'system', eventType, data || {});
}

function getLog(jobId) {
  var logFile = path.join(config.jobsPath, jobId, 'dispatcher-log.jsonl');
  if (!fs.existsSync(logFile)) return [];
  
  var lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  return lines.filter(Boolean).map(function(line) {
    try { return JSON.parse(line); } catch(e) { return null; }
  }).filter(Boolean);
}

function getLogHash(jobId) {
  var logFile = path.join(config.jobsPath, jobId, 'dispatcher-log.jsonl');
  if (!fs.existsSync(logFile)) return null;
  
  var crypto = require('crypto');
  var content = fs.readFileSync(logFile);
  return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = {
  logUserMessage: logUserMessage,
  logAssistantMessage: logAssistantMessage,
  logEvent: logEvent,
  getLog: getLog,
  getLogHash: getLogHash,
};
