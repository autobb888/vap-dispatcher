/**
 * Standalone key generation for dispatcher
 * Uses SDK's compiled code directly
 */

const fs = require('fs');
const path = require('path');

/**
 * Generate a new Verus keypair
 * Uses SDK's compiled code if available, otherwise defers
 */
function generateKeypair(network = 'verustest') {
  const sdkPath = path.join(__dirname, '../vap-agent-sdk');
  const keypairPath = path.join(sdkPath, 'dist/identity/keypair.js');
  
  if (fs.existsSync(keypairPath)) {
    // Use SDK if available
    const { generateKeypair: sdkGenerate } = require(keypairPath);
    return sdkGenerate(network);
  }
  
  // Fallback: use SDK source with ts-node or similar
  throw new Error('SDK not built. Run: cd vap-agent-sdk && npm install && npm run build');
}

/**
 * Restore keypair from WIF
 */
function keypairFromWIF(wif, network = 'verustest') {
  const sdkPath = path.join(__dirname, '../vap-agent-sdk');
  const keypairPath = path.join(sdkPath, 'dist/identity/keypair.js');
  
  if (fs.existsSync(keypairPath)) {
    const { keypairFromWIF: sdkFromWIF } = require(keypairPath);
    return sdkFromWIF(wif, network);
  }
  
  throw new Error('SDK not built. Run: cd vap-agent-sdk && npm install && npm run build');
}

module.exports = {
  generateKeypair,
  keypairFromWIF,
};
