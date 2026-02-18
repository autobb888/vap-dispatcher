/**
 * API Proxy — holds real API keys, containers auth with their tokens
 * 
 * Containers send requests to http://host:19100/v1/...
 * Proxy validates their token, swaps it for the real API key,
 * forwards to the actual provider.
 */
var http = require('http');
var config = require('./config');

var validTokens = new Map(); // token → { jobId, createdAt }
var requestCounts = new Map(); // token → { count, windowStart }
var server = null;

function registerToken(token, jobId) {
  validTokens.set(token, { jobId: jobId, createdAt: Date.now() });
  console.log('[PROXY] Registered token for job ' + jobId.slice(0, 8));
}

function revokeToken(token) {
  var info = validTokens.get(token);
  if (info) {
    console.log('[PROXY] Revoked token for job ' + info.jobId.slice(0, 8));
  }
  validTokens.delete(token);
  requestCounts.delete(token);
}

function checkRateLimit(token) {
  var now = Date.now();
  var entry = requestCounts.get(token);
  if (!entry || (now - entry.windowStart > 60000)) {
    requestCounts.set(token, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  if (entry.count > config.proxyRateLimit) return false;
  return true;
}

function extractToken(req) {
  var auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function determineUpstream(path) {
  // Route embeddings to OpenRouter, everything else to NVIDIA
  if (path.indexOf('/embeddings/') !== -1) {
    return {
      baseUrl: config.openrouterBaseUrl,
      apiKey: config.openrouterApiKey,
      // Strip /embeddings prefix from path
      path: path.replace('/embeddings', '')
    };
  }
  return {
    baseUrl: config.nvidiaBaseUrl,
    apiKey: config.nvidiaApiKey,
    path: path
  };
}

async function handleRequest(req, res) {
  // CORS / health
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tokens: validTokens.size }));
    return;
  }

  // Auth
  var token = extractToken(req);
  if (!token || !validTokens.has(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // Rate limit
  if (!checkRateLimit(token)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limited' }));
    return;
  }

  // Read body
  var chunks = [];
  req.on('data', function(chunk) {
    chunks.push(chunk);
    // Max 100KB body
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    if (total > 102400) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      req.destroy();
    }
  });

  req.on('end', async function() {
    var body = Buffer.concat(chunks);
    var upstream = determineUpstream(req.url);
    var upstreamUrl = upstream.baseUrl + upstream.path;

    try {
      var upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + upstream.apiKey,
        },
        body: body.length > 0 ? body : undefined,
      });

      var upstreamBody = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        'Content-Type': upstreamRes.headers.get('content-type') || 'application/json'
      });
      res.end(upstreamBody);
    } catch (e) {
      console.error('[PROXY] Upstream error:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream error: ' + e.message }));
    }
  });
}

function start() {
  return new Promise(function(resolve) {
    server = http.createServer(handleRequest);
    server.listen(config.proxyPort, '127.0.0.1', function() {
      console.log('[PROXY] ✅ API proxy listening on 127.0.0.1:' + config.proxyPort);
      resolve();
    });
  });
}

function stop() {
  if (server) server.close();
}

module.exports = {
  start: start,
  stop: stop,
  registerToken: registerToken,
  revokeToken: revokeToken,
};
