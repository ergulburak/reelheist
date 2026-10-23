// Pack signature verification. Pure WebCrypto, identical in Node 22 and Chrome 137+.

const subtle = () => globalThis.crypto.subtle;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(bytes) {
  return toHex(await subtle().digest('SHA-256', bytes));
}

// First 16 hex chars of SHA-256(raw public key), in groups of four.
export async function fingerprint(publicKeyB64) {
  const hex = (await sha256Hex(b64ToBytes(publicKeyB64))).slice(0, 16);
  return hex.match(/.{4}/g).join(' ');
}

// Resolves false (never throws) for a bad signature, key or encoding.
export async function verifyPack(bytes, sigB64, publicKeyB64) {
  try {
    const key = await subtle().importKey('raw', b64ToBytes(publicKeyB64), { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, b64ToBytes(sigB64.trim()), bytes);
  } catch {
    return false;
  }
}
