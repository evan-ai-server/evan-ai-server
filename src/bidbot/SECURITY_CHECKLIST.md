# Iron Shield — Security Audit Checklist

Five things you MUST do before this goes to production.

---

## 1. Set `VAULT_MASTER_KEY` as a Secret (NOT in `.env`)

The master encryption key must live in your cloud secret manager, not a `.env` file that can be committed or read from disk.

**eBay/Railway:**
```
railway secrets set VAULT_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

**AWS:**
```bash
aws secretsmanager create-secret --name evan-ai/vault-master-key \
  --secret-string "$(openssl rand -hex 32)"
```

Then fetch in `index.js` at boot, before the server accepts any connections. If the key is missing, the server must refuse to start (vault.js already enforces this with a thrown Error).

**NEVER log `process.env.VAULT_MASTER_KEY`. NEVER commit it.**

---

## 2. Move Token Store to Redis (Isolated Instance)

The current `_tokenStore` Map is in-process — it will be lost on restart and shared across nothing. Swap it for Redis with:

- **Encryption-in-transit**: Redis 6+ TLS (`rediss://`)
- **Auth**: `requirepass` set, no unauthenticated connections
- **Network isolation**: Redis instance inside a private VPC — not accessible from public internet
- **Key TTL**: Set `EXPIRE vault:{ref} 86400` (24h) — stale tokens auto-expire
- **No Redis persistence** (`appendonly no`) — tokens should not survive a Redis restart

---

## 3. Place Audit Route Behind VPC + Admin Token

The `/api/bidbot/audit` route returns internal error details. In production:

- Add a VPC security group rule: only allow traffic from your admin IP or bastion host
- Set `ADMIN_AUDIT_KEY` to a 48-char random hex string (different from VAULT_MASTER_KEY)
- Consider removing the HTTP route entirely and using `railway run` / direct DB query for audit access

---

## 4. Enforce HTTPS Everywhere + Secure Headers

The vault's security model assumes the transport layer is encrypted. Confirm:

```js
// In index.js — already using helmet, verify these are set:
app.use(helmet());
app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true }));
```

- TLS 1.2+ only (disable TLS 1.0/1.1 at your load balancer)
- HSTS header with 1-year max-age
- No mixed content — all API calls over HTTPS

---

## 5. Rotate the Master Key Quarterly (Key Rotation Protocol)

AES-256-GCM is strong, but key rotation limits blast radius if the key is ever exposed.

**Rotation process:**
1. Generate new key: `openssl rand -hex 32`
2. Boot a migration script that decrypts all vault entries with OLD key, re-encrypts with NEW key
3. Update the secret in your secret manager
4. Redeploy — server picks up new key at next process start
5. Revoke old key from secret manager (not just rotate)

**Rotation script skeleton:**
```js
// rotate.js (run once, then delete)
import { _tokenStore } from "./src/vault.js";  // expose for migration only
// decrypt with OLD_KEY, re-encrypt with NEW_KEY, write back
```

Do NOT keep a plaintext log of the rotation. Record only: timestamp, number of records rotated, hash of new key (not the key itself).

---

## Summary

| Check | Status |
|-------|--------|
| `VAULT_MASTER_KEY` in secret manager, not `.env` | ☐ |
| Token store on isolated Redis with TLS + TTL | ☐ |
| Audit route behind VPC + admin token | ☐ |
| HTTPS enforced + HSTS header | ☐ |
| Key rotation schedule set (quarterly) | ☐ |

All five must be ✅ before the first user OAuth token is stored.
