/**
 * SafeChat WebSocket — connects to VAP SafeChat, routes messages
 */
var config = require('./config');
var sio = require('socket.io-client');

var chatSocket = null;
var joinedRooms = new Set();
var messageHandler = null; // function(jobId, content, senderVerusId)

function setMessageHandler(handler) {
  messageHandler = handler;
}

async function connect(vapClient) {
  var sessionToken = vapClient.getSessionToken();
  if (!sessionToken) {
    console.error('[CHAT] No session token, skipping chat connection');
    return;
  }

  var tokenRes = await vapClient.authFetch(config.vapApi + '/v1/chat/token');
  var tokenData = await tokenRes.json();
  var chatToken = tokenData.data && tokenData.data.token;
  if (!chatToken) {
    console.error('[CHAT] Failed to get chat token');
    return;
  }

  return new Promise(function(resolve) {
    chatSocket = sio.io(config.vapApi, {
      path: '/ws',
      auth: { token: chatToken },
      extraHeaders: { 'Cookie': 'verus_session=' + sessionToken },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
    });

    chatSocket.on('connect', function() {
      console.log('[CHAT] ✅ Connected to SafeChat');
      joinedRooms.forEach(function(jobId) {
        chatSocket.emit('join_job', { jobId: jobId });
      });
      resolve();
    });

    chatSocket.on('disconnect', function(reason) {
      console.log('[CHAT] Disconnected: ' + reason);
    });

    chatSocket.on('connect_error', function(err) {
      console.error('[CHAT] Connection error: ' + err.message);
      resolve();
    });

    chatSocket.on('joined', function(data) {
      console.log('[CHAT] Joined room for job ' + data.jobId);
    });

    chatSocket.on('message', function(msg) {
      // Ignore own messages
      if (msg.senderVerusId === config.vapIAddress || msg.senderVerusId === config.vapIdentity) return;
      if (msg.senderVerusId === 'system') {
        console.log('[CHAT] System: ' + msg.content);
        return;
      }

      console.log('[CHAT] 💬 [' + (msg.jobId || '?').slice(0, 8) + '] ' + msg.senderVerusId + ': ' + msg.content);

      if (msg.jobId && msg.content && messageHandler) {
        messageHandler(msg.jobId, msg.content, msg.senderVerusId);
      }
    });

    chatSocket.on('error', function(data) {
      console.error('[CHAT] Error: ' + (data.message || JSON.stringify(data)));
    });

    setTimeout(function() { resolve(); }, 5000);
  });
}

function joinRoom(jobId) {
  joinedRooms.add(jobId);
  if (chatSocket && chatSocket.connected) {
    chatSocket.emit('join_job', { jobId: jobId });
  }
}

function sendMessage(jobId, content) {
  if (chatSocket && chatSocket.connected) {
    chatSocket.emit('message', { jobId: jobId, content: content });
    return true;
  }
  console.error('[CHAT] Not connected, cannot send message');
  return false;
}

function isConnected() {
  return chatSocket && chatSocket.connected;
}

module.exports = {
  connect: connect,
  joinRoom: joinRoom,
  sendMessage: sendMessage,
  setMessageHandler: setMessageHandler,
  isConnected: isConnected,
};
