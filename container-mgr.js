/**
 * Container Manager — Docker lifecycle for ephemeral agent containers
 * 
 * Manages port allocation, container creation, health checks, and cleanup.
 * Uses child_process.exec for Docker commands (no Docker SDK dependency).
 */
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var config = require('./config');

// Port pool
var freePorts = new Set();
var usedPorts = new Map(); // port → { jobId, containerId, token, createdAt }
var cooldownPorts = new Set(); // ports in cooldown after release

// Initialize port pool
for (var p = config.portRangeStart; p <= config.portRangeEnd; p++) {
  freePorts.add(p);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getAvailablePort() {
  for (var port of freePorts) {
    if (!cooldownPorts.has(port)) return port;
  }
  return null;
}

function generateContainerConfig(token) {
  var proxyUrl = 'http://host.docker.internal:' + config.proxyPort;
  
  return JSON.stringify({
    models: {
      mode: 'merge',
      providers: {
        proxy: {
          baseUrl: proxyUrl + '/v1',
          api: 'openai-completions',
          apiKey: token,
          models: [{
            id: config.model,
            name: 'Kimi K2.5',
            reasoning: true,
            input: ['text'],
            cost: { input: 0, output: 0 },
            contextWindow: 131072,
            maxTokens: 16384
          }]
        }
      }
    },
    gateway: {
      mode: 'local',
      auth: {
        mode: 'token',
        token: token
      },
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true
          }
        }
      }
    },
    agents: {
      defaults: {
        model: { primary: 'proxy/' + config.model },
        workspace: '/agent/.openclaw/workspace',
        memorySearch: {
          provider: 'openai',
          remote: {
            baseUrl: proxyUrl + '/embeddings/v1/',
            apiKey: token
          },
          model: 'openai/text-embedding-3-small'
        }
      },
      list: [{
        id: 'main',
        memorySearch: {
          extraPaths: ['/data/wiki']
        }
      }]
    }
  }, null, 2);
}

/**
 * Start a new container for a job
 * Returns { port, containerId, token } or null on failure
 */
async function startContainer(jobId) {
  var port = getAvailablePort();
  if (!port) {
    console.error('[DOCKER] No available ports');
    return null;
  }

  var token = generateToken();
  var containerName = 'ari2-' + jobId.slice(0, 8);
  
  // Create job directory
  var jobDir = path.join(config.jobsPath, jobId);
  if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

  // Write container config to tmp
  var configDir = path.join(config.tmpConfigBase, jobId);
  var openclawDir = path.join(configDir, '.openclaw');
  var workspaceDir = path.join(openclawDir, 'workspace');
  var memoryDir = path.join(workspaceDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, 'openclaw.json'), generateContainerConfig(token));
  
  // Copy agent personality files if they exist
  var agentFilesDir = path.join(__dirname, '..', 'docker', 'agent-files');
  var filesToCopy = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'];
  filesToCopy.forEach(function(f) {
    var src = path.join(agentFilesDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(workspaceDir, f));
    }
  });

  // Build docker run command
  var cmd = 'docker run -d' +
    ' --name ' + containerName +
    ' --memory ' + config.containerMemory +
    ' --cpus ' + config.containerCpus +
    ' --read-only' +
    ' --cap-drop ALL' +
    ' --security-opt no-new-privileges' +
    ' --tmpfs /tmp:rw,noexec,size=50m' +
    ' --tmpfs /agent/.cache:rw,noexec,size=50m' +
    ' -p 127.0.0.1:' + port + ':18789' +
    ' -v ' + config.wikiPath + ':/data/wiki:ro' +
    ' -v ' + jobDir + ':/data/job' +
    ' -v ' + configDir + ':/agent:ro' +
    ' --add-host host.docker.internal:host-gateway' +
    ' -e OPENCLAW_HOME=/agent' +
    ' -e JOB_ID=' + jobId +
    ' ' + config.dockerImage;

  return new Promise(function(resolve) {
    console.log('[DOCKER] Starting container for job ' + jobId.slice(0, 8) + ' on port ' + port);
    
    exec(cmd, function(err, stdout, stderr) {
      if (err) {
        console.error('[DOCKER] ❌ Failed to start container:', stderr || err.message);
        resolve(null);
        return;
      }

      var containerId = stdout.trim().slice(0, 12);
      freePorts.delete(port);
      usedPorts.set(port, {
        jobId: jobId,
        containerId: containerId,
        containerName: containerName,
        token: token,
        createdAt: Date.now(),
      });

      console.log('[DOCKER] Container ' + containerId + ' started on port ' + port);
      resolve({ port: port, containerId: containerId, token: token });
    });
  });
}

/**
 * Wait for container to be healthy (HTTP endpoint responding)
 */
async function waitForHealth(port, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  var start = Date.now();
  var url = 'http://127.0.0.1:' + port + '/v1/chat/completions';
  var info = usedPorts.get(port);
  var token = info ? info.token : '';

  while ((Date.now() - start) < timeoutMs) {
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }]
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        console.log('[DOCKER] ✅ Container on port ' + port + ' is healthy (' + (Date.now() - start) + 'ms)');
        return true;
      }
    } catch (e) {
      // Not ready yet
    }
    await new Promise(function(r) { setTimeout(r, 2000); });
  }
  
  console.error('[DOCKER] ⚠️ Container on port ' + port + ' failed health check after ' + timeoutMs + 'ms');
  return false;
}

/**
 * Send a chat message to a container and get the response
 */
async function sendToContainer(port, message, nonce) {
  var info = usedPorts.get(port);
  if (!info) throw new Error('No container on port ' + port);

  var url = 'http://127.0.0.1:' + port + '/v1/chat/completions';
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + info.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: message }]
    }),
    signal: AbortSignal.timeout(300000), // 5 min
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error('Container HTTP ' + res.status + ': ' + errText.slice(0, 200));
  }

  var data = await res.json();
  var choice = data.choices && data.choices[0];
  if (choice && choice.message && choice.message.content) {
    return choice.message.content;
  }
  throw new Error('No content in container response');
}

/**
 * Stop and remove a container, release its port
 */
async function destroyContainer(port) {
  var info = usedPorts.get(port);
  if (!info) return;

  var containerName = info.containerName;
  console.log('[DOCKER] Destroying container ' + containerName + ' on port ' + port);

  return new Promise(function(resolve) {
    exec('docker stop ' + containerName + ' && docker rm ' + containerName, function(err) {
      if (err) console.error('[DOCKER] Cleanup error:', err.message);

      // Clean up config tmpdir
      var configDir = path.join(config.tmpConfigBase, info.jobId);
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch(e) {}

      usedPorts.delete(port);
      
      // Port cooldown before reuse
      cooldownPorts.add(port);
      setTimeout(function() {
        cooldownPorts.delete(port);
        freePorts.add(port);
        console.log('[DOCKER] Port ' + port + ' released');
      }, config.portCooldown);

      console.log('[DOCKER] ✅ Container ' + containerName + ' destroyed');
      resolve();
    });
  });
}

/**
 * Kill containers that exceeded max lifetime
 */
function enforceLifetimes(onExpired) {
  var now = Date.now();
  usedPorts.forEach(function(info, port) {
    if ((now - info.createdAt) > config.containerMaxLifetime) {
      console.log('[DOCKER] Container on port ' + port + ' exceeded max lifetime');
      if (onExpired) onExpired(info.jobId, port);
    }
  });
}

function getContainerInfo(port) {
  return usedPorts.get(port) || null;
}

function getActiveContainerCount() {
  return usedPorts.size;
}

function getPortForJob(jobId) {
  for (var entry of usedPorts.entries()) {
    if (entry[1].jobId === jobId) return entry[0];
  }
  return null;
}

module.exports = {
  startContainer: startContainer,
  waitForHealth: waitForHealth,
  sendToContainer: sendToContainer,
  destroyContainer: destroyContainer,
  enforceLifetimes: enforceLifetimes,
  getContainerInfo: getContainerInfo,
  getActiveContainerCount: getActiveContainerCount,
  getPortForJob: getPortForJob,
  generateToken: generateToken,
};
