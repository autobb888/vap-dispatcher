/**
 * Register ari3.agentplatform@ via VAP platform-assisted onboarding
 * 
 * Flow:
 * 1. Load keypair from ~/.vap-keys.json
 * 2. POST /v1/onboard with name, address, pubkey, signature
 * 3. Poll /v1/onboard/status/:onboardId until registered
 * 4. Update multimap with services
 */

const fs = require('fs');
const crypto = require('crypto');

const API = 'https://api.autobb.app';
const IDENTITY_NAME = 'ari3';
const FULL_IDENTITY = 'ari3.agentplatform@';

// Load keys
const keys = JSON.parse(fs.readFileSync('/home/vap-av1/.vap-keys.json', 'utf8'));
console.log('Loaded keys for address:', keys.address);

// Helper: Sign message with WIF using @noble/secp256k1
async function signMessage(message, wif) {
  const secp256k1 = require('@noble/secp256k1');
  const { sha256 } = require('@noble/hashes/sha2');
  const bs58check = require('bs58check');
  
  // Decode WIF to private key
  const decoded = bs58check.decode(wif);
  // WIF format: 1 byte version + 32 byte privkey + [optional 1 byte compression flag] + 4 byte checksum
  const privKey = decoded.slice(1, 33);
  
  const msgHash = sha256(message);
  const signature = await secp256k1.sign(msgHash, privKey);
  return Buffer.from(signature).toString('base64');
}

async function onboardIdentity() {
  try {
    // Step 1: Get challenge
    console.log('\n[1/4] Getting challenge from VAP...');
    const challengeRes = await fetch(API + '/v1/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: IDENTITY_NAME,
        address: keys.address,
        pubkey: keys.pubkey
      })
    });
    
    if (!challengeRes.ok) {
      const err = await challengeRes.text();
      console.error('Challenge failed:', err);
      return;
    }
    
    const challengeData = await challengeRes.json();
    console.log('Challenge received:', challengeData.challenge);
    
    // Step 2: Sign challenge
    console.log('\n[2/4] Signing challenge...');
    const signature = await signMessage(challengeData.challenge, keys.wif);
    console.log('Signature:', signature.slice(0, 50) + '...');
    
    // Step 3: Submit signature
    console.log('\n[3/4] Submitting registration...');
    const registerRes = await fetch(API + '/v1/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: IDENTITY_NAME,
        address: keys.address,
        pubkey: keys.pubkey,
        challenge: challengeData.challenge,
        token: challengeData.token,
        signature: signature
      })
    });
    
    if (!registerRes.ok) {
      const err = await registerRes.text();
      console.error('Registration failed:', err);
      return;
    }
    
    const registerData = await registerRes.json();
    console.log('Registration submitted!');
    console.log('Onboard ID:', registerData.onboardId);
    console.log('Status:', registerData.status);
    
    // Step 4: Poll for completion
    console.log('\n[4/4] Polling for registration completion...');
    await pollStatus(registerData.onboardId);
    
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  }
}

async function pollStatus(onboardId) {
  const maxAttempts = 30; // 5 minutes at 10s intervals
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 10000)); // 10 second delay
    
    try {
      const res = await fetch(API + '/v1/onboard/status/' + onboardId);
      const data = await res.json();
      
      console.log(`  Poll ${i + 1}: status = ${data.status}`);
      
      if (data.status === 'registered') {
        console.log('\n✅ Identity registered successfully!');
        console.log('Identity:', data.identity);
        console.log('I-Address:', data.iAddress);
        console.log('Transaction:', data.txid);
        
        // Save identity info
        const identityInfo = {
          name: FULL_IDENTITY,
          iAddress: data.iAddress,
          address: keys.address,
          registeredAt: new Date().toISOString()
        };
        fs.writeFileSync('/home/vap-av1/.vap/identity.json', JSON.stringify(identityInfo, null, 2));
        console.log('\nIdentity info saved to ~/.vap/identity.json');
        return;
      }
      
      if (data.status === 'failed') {
        console.error('\n❌ Registration failed:', data.error);
        return;
      }
      
      // Still pending, continue polling
    } catch (e) {
      console.log(`  Poll ${i + 1}: error - ${e.message}`);
    }
  }
  
  console.error('\n⏱️ Timeout: Registration is taking longer than expected.');
  console.log('Check status manually with:');
  console.log(`  curl https://api.autobb.app/v1/onboard/status/${onboardId}`);
}

// Run
onboardIdentity();
