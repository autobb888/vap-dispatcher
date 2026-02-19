/**
 * Standalone key generation for dispatcher
 * Doesn't require SDK to be built
 */

const crypto = require('crypto');
const bs58check = require('bs58check');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');

const ECPair = ECPairFactory(tinysecp);

// Verus network constants
const VERUS_NETWORK = {
  messagePrefix: '\x19Verus Signed Message:\n',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x3c,  // R-address
  scriptHash: 0x55,
  wif: 0x80,
};

/**
 * Generate a new Verus keypair
 */
function generateKeypair(network = 'verustest') {
  const keyPair = ECPair.makeRandom();
  const { address } = payments.p2pkh({ 
    pubkey: keyPair.publicKey, 
    network: network === 'verustest' ? VERUS_NETWORK : VERUS_MAINNET 
  });
  
  return {
    wif: keyPair.toWIF(),
    pubkey: keyPair.publicKey.toString('hex'),
    address: address,
  };
}

/**
 * Restore keypair from WIF
 */
function keypairFromWIF(wif, network = 'verustest') {
  const keyPair = ECPair.fromWIF(wif);
  const { address } = payments.p2pkh({ 
    pubkey: keyPair.publicKey,
    network: network === 'verustest' ? VERUS_NETWORK : VERUS_MAINNET
  });
  
  return {
    wif: wif,
    pubkey: keyPair.publicKey.toString('hex'),
    address: address,
  };
}

module.exports = {
  generateKeypair,
  keypairFromWIF,
};
