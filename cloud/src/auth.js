// All crypto here uses the runtime's native WebCrypto (crypto.subtle) —
// Workers have no filesystem-based secret store and no Node crypto module by
// default, and this keeps the Worker dependency-free. Two unrelated
// mechanisms live in this file:
//   - password hashing (PBKDF2, not bcrypt — see cloud/README.md for why)
//   - stateless parent session cookies (HMAC-signed, no server-side store)
//   - device bearer-token verification (sha256 comparison against a stored hash)

// Cloudflare Workers' WebCrypto implementation hard-caps PBKDF2 at 100,000
// iterations (crypto.subtle.deriveBits throws NotSupportedError above that,
// discovered live: OWASP's current general recommendation of 210,000
// doesn't fit this platform) — 100,000 is the max this runtime allows.
const PBKDF2_ITERATIONS = 100_000;
const HASH_ALGO = 'SHA-256';
const COOKIE_NAME = 'kh_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, matches the old express-session cookie

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function base64url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- Password hashing (PBKDF2) ---

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: HASH_ALGO },
    key,
    256,
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, iterationsStr, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'pbkdf2' || !saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: Number(iterationsStr), hash: HASH_ALGO },
    key,
    256,
  );
  return timingSafeEqual(toHex(bits), hashHex);
}

// --- Parent session cookie (stateless, HMAC-signed) ---

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createSessionCookie(secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ loggedIn: true, iat: now, exp: now + SESSION_MAX_AGE_SECONDS });
  const payloadB64 = base64url(new TextEncoder().encode(payload));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payloadB64));
  return `${COOKIE_NAME}=${payloadB64}.${base64url(sig)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function expiredSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function readSession(request, secret) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const dot = match[1].indexOf('.');
  if (dot < 0) return null;
  const payloadB64 = match[1].slice(0, dot);
  const sigB64 = match[1].slice(dot + 1);
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    base64urlToBytes(sigB64),
    new TextEncoder().encode(payloadB64),
  );
  if (!valid) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// --- Device bearer token ---

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Token shape: "<deviceId>.<secret>" — id is a fast lookup key, only the
// sha256 of the secret half is ever stored (see cloud/scripts/create-device.js).
export function parseDeviceToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  return { id: token.slice(0, dot), secret: token.slice(dot + 1) };
}
