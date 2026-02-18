/**
 * VAP API Client — auth, job polling, job acceptance
 */
var config = require('./config');
var fs = require('fs');

var keys = null;
var sessionCookie = null;
var sessionToken = null;
var signChallenge = null;

function init() {
  keys = JSON.parse(fs.readFileSync(config.vapKeysFile, 'utf8'));
  // Requires vap-agent-sdk to be installed: npm install @autobb/vap-agent
  signChallenge = require('@autobb/vap-agent/dist/identity/signer.js').signChallenge;
}

async function login() {
  console.log('[VAP] Logging in...');
  var res = await fetch(config.vapApi + '/auth/challenge');
  var data = await res.json();
  var ch = data.data;
  var signature = signChallenge(keys.wif, ch.challenge, config.vapIAddress, 'verustest');

  var loginRes = await fetch(config.vapApi + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: ch.challengeId,
      verusId: config.vapIdentity,
      signature: signature
    }),
  });

  var loginData = await loginRes.json();
  if (!loginData.data || !loginData.data.success) {
    throw new Error('Login failed: ' + JSON.stringify(loginData));
  }

  var rawCookie = loginRes.headers.get('set-cookie') || '';
  var match = rawCookie.match(/verus_session=([^;]+)/);
  sessionToken = match ? match[1] : null;
  sessionCookie = sessionToken ? 'verus_session=' + sessionToken : rawCookie;
  console.log('[VAP] ✅ Logged in as ' + loginData.data.identityName);
}

async function authFetch(url, options) {
  options = options || {};
  if (!sessionCookie) await login();

  var headers = Object.assign({}, options.headers || {}, { 'Cookie': sessionCookie });
  var res = await fetch(url, Object.assign({}, options, { headers: headers }));

  if (res.status === 401) {
    console.log('[VAP] Session expired, re-authenticating...');
    await login();
    headers = Object.assign({}, options.headers || {}, { 'Cookie': sessionCookie });
    res = await fetch(url, Object.assign({}, options, { headers: headers }));
  }
  return res;
}

async function getRequestedJobs() {
  var res = await authFetch(config.vapApi + '/v1/me/jobs?status=requested&role=seller');
  var data = await res.json();
  return (data.data || []);
}

async function getActiveJobs() {
  var jobs = [];
  var statuses = ['accepted', 'in_progress'];
  for (var i = 0; i < statuses.length; i++) {
    var res = await authFetch(config.vapApi + '/v1/me/jobs?status=' + statuses[i] + '&role=seller');
    var data = await res.json();
    if (data.data) jobs = jobs.concat(data.data);
  }
  return jobs;
}

async function getJobDetail(jobId) {
  var res = await authFetch(config.vapApi + '/v1/jobs/' + jobId);
  var data = await res.json();
  return data.data || null;
}

async function acceptJob(jobId) {
  var detail = await getJobDetail(jobId);
  if (!detail || !detail.jobHash) {
    console.error('[VAP] Could not get details for job ' + jobId);
    return false;
  }

  var timestamp = Math.floor(Date.now() / 1000);
  var message = 'VAP-ACCEPT|Job:' + detail.jobHash +
    '|Buyer:' + detail.buyerVerusId +
    '|Amt:' + detail.amount + ' ' + detail.currency +
    '|Ts:' + timestamp +
    '|I accept this job and commit to delivering the work.';
  
  var signature = signChallenge(keys.wif, message, config.vapIAddress, 'verustest');

  var res = await authFetch(config.vapApi + '/v1/jobs/' + jobId + '/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp: timestamp, signature: signature }),
  });

  var data = await res.json();
  if (res.status === 200 || res.status === 201) {
    console.log('[VAP] ✅ Accepted job ' + jobId);
    return true;
  } else {
    console.error('[VAP] ❌ Accept failed:', JSON.stringify(data));
    return false;
  }
}

function getSessionToken() {
  return sessionToken;
}

function getSessionCookie() {
  return sessionCookie;
}

module.exports = {
  init: init,
  login: login,
  authFetch: authFetch,
  getRequestedJobs: getRequestedJobs,
  getActiveJobs: getActiveJobs,
  getJobDetail: getJobDetail,
  acceptJob: acceptJob,
  getSessionToken: getSessionToken,
  getSessionCookie: getSessionCookie,
};
