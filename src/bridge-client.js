/**
 * Bridge Client
 * 
 * WebSocket client that runs inside agent containers.
 * Connects to the dispatcher's bridge server.
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');

class BridgeClient extends EventEmitter {
  constructor(url, agentId) {
    super();
    this.url = url;
    this.agentId = agentId;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
  }
  
  async connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.url}/${this.agentId}`;
      console.log(`[BridgeClient] Connecting to ${wsUrl}`);
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        console.log('[BridgeClient] Connected');
        this.reconnectAttempts = 0;
        this.emit('connected');
        resolve();
      });
      
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          this.emit('message', msg);
        } catch (e) {
          console.error('[BridgeClient] Failed to parse message:', e.message);
        }
      });
      
      this.ws.on('close', () => {
        console.log('[BridgeClient] Disconnected');
        this.emit('disconnected');
        this.reconnect();
      });
      
      this.ws.on('error', (err) => {
        console.error('[BridgeClient] Error:', err.message);
        this.emit('error', err);
        reject(err);
      });
    });
  }
  
  reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[BridgeClient] Max reconnect attempts reached');
      this.emit('failed');
      return;
    }
    
    this.reconnectAttempts++;
    console.log(`[BridgeClient] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect().catch(() => {});
    }, this.reconnectDelay);
  }
  
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
  
  onMessage(handler) {
    this.on('message', handler);
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

module.exports = {
  BridgeClient,
};
