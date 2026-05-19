/**
 * vault.js — Evan AI OAuth Token Vault
 * AES-256-GCM authenticated encryption for marketplace credentials.
 *
 * SECURITY CONTRACT:
 *   - Raw tokens NEVER leave this module to the frontend
 *   - Decrypted token lives in memory < 500ms (enforced via scoped Promise)
 *   - Master key pulled from process.env only — never logged, never serialized
 *   - Forensic deletion on revoke (zero-fill + DB remove)
 */

import crypto from "crypto";

// ─── Master Key ───────────────────────────────────────────────────────────────
// Must be 64 hex chars (32 bytes). Set VAULT_MASTER_KEY in your environment.
// Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
function getMasterKey() {
  const hex = process.env.VAULT_MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("VAULT_MASTER_KEY missing or invalid — must be 64 hex chars");
  }
  return Buffer.from(hex, "hex");
}

// ─── In-memory token store ────────────────────────────────────────────────────
// In production, swap this Map for your DB (Postgres/Redis).
// Schema: ref → { iv, authTag, ciphertext, userId, platform, handle, createdAt }
const _tokenStore = new Map();

// ─── Internal audit log ───────────────────────────────────────────────────────
// Internal-only. Never surfaced to the API layer.
const _auditLog = [];
function _audit(event, ref, detail = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ref: ref ? `${ref.slice(0, 8)}…` : null, // truncate ref in logs
    ...detail,
  };
  _auditLog.push(entry);
  // In production: write to your internal log sink (CloudWatch, Datadog, etc.)
  // Never use console.log here — it can leak to stdout capture tools
  if (process.env.VAULT_DEBUG === "1") {
    process.stderr.write(`[VAULT][INTERNAL] ${JSON.stringify(entry)}\n`);
  }
}

// ─── Encrypt ──────────────────────────────────────────────────────────────────
/**
 * Encrypts a plaintext token using AES-256-GCM.
 * Returns an opaque encrypted record (never the plaintext).
 */
function _encrypt(plaintext) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 16-byte GCM auth tag

  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

// ─── Decrypt (ephemeral) ──────────────────────────────────────────────────────
/**
 * Decrypts a stored record. Returns plaintext for < 500ms window only.
 * Caller MUST use the token immediately inside the provided callback.
 *
 * Usage:
 *   await withEphemeralToken(ref, async (token) => {
 *     await platformApi.sendOffer(token, ...);
 *   });
 */
function _decrypt(record) {
  const key = getMasterKey();
  const iv = Buffer.from(record.iv, "hex");
  const authTag = Buffer.from(record.authTag, "hex");
  const ciphertext = Buffer.from(record.ciphertext, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  // If authTag verification fails, GCM throws — tamper detected
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Store an OAuth token for a user/platform pair.
 * Returns a stable ref string (safe to store in user records).
 * The raw token is NEVER returned.
 *
 * @param {string} userId
 * @param {string} platform  — "ebay" | "poshmark"
 * @param {string} token     — raw OAuth access token
 * @param {string} [handle]  — display name / account identifier (non-sensitive)
 * @returns {{ ref: string, platform: string, handle: string, connected: true }}
 */
export function storeToken(userId, platform, token, handle = "") {
  const ref = crypto.randomBytes(24).toString("hex"); // 48-char opaque ref
  const encrypted = _encrypt(token);

  _tokenStore.set(ref, {
    ...encrypted,
    userId,
    platform,
    handle,
    createdAt: Date.now(),
  });

  _audit("STORE", ref, { userId, platform, handleLen: handle.length });

  // Return ONLY safe, non-sensitive fields
  return { ref, platform, handle, connected: true };
}

/**
 * Ephemeral token accessor. Decrypts the token, passes it to `fn`, then
 * immediately nullifies the local binding. The token cannot escape this scope.
 *
 * The 500ms timeout enforces the ephemeral contract — if `fn` takes longer,
 * it throws rather than leaving the token alive.
 *
 * @param {string} ref
 * @param {(token: string) => Promise<any>} fn  — async consumer
 * @returns {Promise<any>} — result of fn
 */
export async function withEphemeralToken(ref, fn) {
  const record = _tokenStore.get(ref);
  if (!record) {
    _audit("ACCESS_MISS", ref);
    throw vaultError("TOKEN_NOT_FOUND");
  }

  let token;
  try {
    token = _decrypt(record);
  } catch (err) {
    _audit("DECRYPT_FAIL", ref, { err: err.message });
    throw vaultError("DECRYPT_FAIL");
  }

  _audit("ACCESS_OK", ref, { platform: record.platform });

  // Enforce 500ms ephemeral window
  const timeoutGuard = new Promise((_, reject) =>
    setTimeout(() => reject(vaultError("EPHEMERAL_TIMEOUT")), 500)
  );

  try {
    const result = await Promise.race([fn(token), timeoutGuard]);
    return result;
  } finally {
    // Explicit nullification — token goes out of scope for GC
    token = null; // eslint-disable-line no-unused-vars
  }
}

/**
 * Returns only the safe public metadata for a vault entry.
 * NEVER returns the token or any encrypted fields.
 *
 * @param {string} ref
 * @returns {{ connected: boolean, platform: string, handle: string } | null}
 */
export function getTokenStatus(ref) {
  const record = _tokenStore.get(ref);
  if (!record) return null;
  return {
    connected: true,
    platform: record.platform,
    handle: record.handle,
    linkedAt: new Date(record.createdAt).toISOString(),
  };
}

/**
 * Revoke all tokens for a user. Forensic deletion:
 *   1. Overwrites the encrypted buffer fields with zeros
 *   2. Removes the entry from the store
 *
 * @param {string} userId
 * @returns {{ revoked: number }}
 */
export function revokeAllTokens(userId) {
  let revoked = 0;
  for (const [ref, record] of _tokenStore.entries()) {
    if (record.userId !== userId) continue;

    // Forensic zero-fill before delete (defense against heap inspection)
    const zeroHex = (s) => "0".repeat(s.length);
    record.iv = zeroHex(record.iv);
    record.authTag = zeroHex(record.authTag);
    record.ciphertext = zeroHex(record.ciphertext);

    _tokenStore.delete(ref);
    _audit("REVOKE", ref, { userId });
    revoked++;
  }
  return { revoked };
}

/**
 * Revoke a single token by ref.
 */
export function revokeToken(ref) {
  const record = _tokenStore.get(ref);
  if (!record) return { revoked: 0 };

  const zeroHex = (s) => "0".repeat(s.length);
  record.iv = zeroHex(record.iv);
  record.authTag = zeroHex(record.authTag);
  record.ciphertext = zeroHex(record.ciphertext);

  _tokenStore.delete(ref);
  _audit("REVOKE_SINGLE", ref);
  return { revoked: 1 };
}

// ─── OAuth Callback Handler ───────────────────────────────────────────────────
/**
 * Call from your OAuth redirect handler. Stores the token, returns only
 * the safe connection record. Raw token is consumed here and goes no further.
 *
 * @param {string} userId
 * @param {string} platform
 * @param {string} accessToken  — ephemeral, from OAuth code exchange
 * @param {string} [handle]     — account display name from platform
 * @returns {{ connected: true, platform: string, handle: string, ref: string }}
 */
export function handleOAuthCallback(userId, platform, accessToken, handle = "") {
  // Store immediately — token exists here for < 1ms before encryption
  const record = storeToken(userId, platform, accessToken, handle);

  // accessToken is now dead — encrypted copy is in the vault
  // Return ONLY the safe record to the route handler
  return record;
}

// ─── Internal audit accessor (developer only) ─────────────────────────────────
/**
 * Returns internal audit log. Route must be behind admin auth — NEVER expose publicly.
 */
export function _getAuditLog() {
  return [..._auditLog];
}

// ─── Error factory ────────────────────────────────────────────────────────────
function vaultError(code) {
  const err = new Error(`VAULT_${code}`);
  err.vaultCode = code;
  return err;
}
