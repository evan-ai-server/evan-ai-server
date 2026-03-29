# Evan AI — B2B Valuation API

Phase 12 — Market Ownership / B2B Foundation.

Evan's B2B Valuation API exposes the same market intelligence that powers the consumer
product in a structured, enterprise-consumable format. Valuations are derived from Evan's
category price indexes — built from real consumer scan data — combined with the calibration
and signal accuracy tracking from Phases 9–11.

**Honesty guarantees:**
- Calibration warnings are never suppressed for B2B clients.
- Data-poor categories return explicit failure reasons, not guessed valuations.
- Confidence scores reflect actual calibration state — they are never inflated.
- B2B output is never more optimistic than the consumer output for the same underlying data.

---

## Authentication

All B2B endpoints require an API key issued by Evan ops:

```
x-api-key: evan_<hex>
```

Keys are issued per organization and scoped to a tier. The raw key is shown once at
creation time. Contact ops to provision a key or change your tier.

Usage limits reset at **00:00 UTC** each day. Current usage is returned in response
headers on every B2B call:

| Header | Value |
|--------|-------|
| `X-B2B-Limit` | Daily limit for this endpoint |
| `X-B2B-Used` | Calls made today |
| `X-B2B-Remaining` | Remaining calls today |

---

## Tiers

| Tier | `valuate`/day | `batch-valuate`/day | `price-index`/day |
|------|--------------|---------------------|-------------------|
| starter | 100 | 5 | 20 |
| growth | 1,000 | 50 | 100 |
| enterprise | 10,000 | 500 | 500 |

---

## Endpoints

### POST `/api/b2b/valuate`

Single-item market valuation.

**Request body:**
```json
{
  "query":    "Nike Air Max 90",          // required, min 3 chars
  "category": "sneakers",                 // required
  "askPrice": 85.00,                      // optional — enables deal-context field
  "itemRef":  "client-internal-id-123"   // optional — passed through unchanged
}
```

**Response (success):**
```json
{
  "ok": true,
  "itemRef": "client-internal-id-123",
  "query": "Nike Air Max 90",
  "category": "sneakers",
  "valuation": {
    "marketMedian": 145.00,
    "p25": 105.00,
    "p75": 185.00,
    "priceRange": { "min": 55.00, "max": 310.00 },
    "spread": 0.55,
    "sampleCount": 87,
    "indexGrade": "B",
    "valuationLabel": "moderate_confidence",
    "dealContext": {
      "askPrice": 85.00,
      "vsMedian": 0.41,
      "assessment": "well_below_market"
    }
  },
  "confidence": 0.73,
  "calibration": {
    "sbWinRate": 84,
    "gdWinRate": 71,
    "isCalibrated": true,
    "calSamples": 143,
    "health": "WELL_CALIBRATED"
  },
  "warnings": [],
  "failureReason": null,
  "generatedAt": "2026-03-29T14:22:01.000Z"
}
```

**Response (failure):**
```json
{
  "ok": false,
  "itemRef": "client-internal-id-123",
  "query": "Nike Air Max 90",
  "category": "obscure_collectibles",
  "valuation": { "indexGrade": "INSUFFICIENT", "sampleCount": 3 },
  "confidence": null,
  "calibration": null,
  "warnings": [],
  "failureReason": "insufficient_samples",
  "generatedAt": "2026-03-29T14:22:01.000Z"
}
```

**Index grades:**

| Grade | Min samples | `confidence` | `valuationLabel` |
|-------|-------------|-------------|-----------------|
| A | 100 | 0.88–0.90 | `high_confidence` |
| B | 30 | 0.70–0.75 | `moderate_confidence` |
| C | 10 | 0.40–0.45 | `low_confidence` |
| INSUFFICIENT | <10 | `null` | `unresolved` |

**`dealContext.assessment` values:**

| Value | Meaning |
|-------|---------|
| `well_below_market` | Ask price ≥25% below category median |
| `below_market` | Ask price 10–24% below median |
| `at_market` | Within ±5% of median |
| `above_market` | Ask price 6–20% above median |
| `significantly_above_market` | Ask price >20% above median |

**Failure reasons:**

| `failureReason` | Meaning |
|----------------|---------|
| `category_not_indexed` | No category provided or category has no index |
| `insufficient_samples` | Fewer than 10 price samples in the index |
| `price_index_unavailable` | Redis error or temporary data unavailability |
| `query_too_vague` | Query string is fewer than 3 characters |
| `internal_error` | Unexpected error (batch only) |

---

### POST `/api/b2b/batch-valuate`

Batch valuation — up to 25 items per request. All items are processed in parallel.
Items sharing the same category use a single price index lookup.

**Request body:**
```json
{
  "items": [
    { "query": "Nike Air Max 90", "category": "sneakers", "askPrice": 85.00, "itemRef": "sku-001" },
    { "query": "Sony WH-1000XM5", "category": "headphones", "itemRef": "sku-002" },
    { "query": "???",             "category": "watches" }
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "count": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    {
      "ok": true,
      "itemRef": "sku-001",
      ...
    },
    {
      "ok": false,
      "itemRef": null,
      "query": "???",
      "category": "watches",
      "failureReason": "query_too_vague",
      ...
    }
  ],
  "generatedAt": "2026-03-29T14:22:01.000Z"
}
```

Limits: max 25 items per request. Excess items are silently dropped.
Each batch request counts as **one** `batch_valuate` call against your daily limit.

---

### GET `/api/b2b/price-index/:category`

Category-level price index. Returns the market distribution for a category
along with calibration health and eligibility grade.

**Request:**
```
GET /api/b2b/price-index/sneakers
x-api-key: evan_...
```

**Response:**
```json
{
  "ok": true,
  "category": "sneakers",
  "index": {
    "indexGrade": "A",
    "sampleCount": 312,
    "medianPrice": 145.00,
    "p25": 95.00,
    "p75": 195.00,
    "priceRange": { "min": 25.00, "max": 580.00 },
    "spread": 0.69,
    "avgPriceQuality": 0.74,
    "calibration": {
      "sbWinRate": 84,
      "gdWinRate": 71,
      "isCalibrated": true,
      "health": "WELL_CALIBRATED",
      "calSamples": 143
    },
    "lastUpdated": "2026-03-29T13:00:00.000Z"
  },
  "eligibility": {
    "ready": true,
    "grade": "A",
    "reason": null
  }
}
```

Index is cached for 1 hour. A category becomes available after 10+ consumer scans
have been recorded for it.

---

### GET `/api/b2b/usage`

Usage statistics for your API key — today's budget and 30-day history.

**Response:**
```json
{
  "ok": true,
  "keyId": "a1b2c3d4",
  "orgId": "acme-corp",
  "tier": "growth",
  "limits": { "valuate": 1000, "batch_valuate": 50, "price_index": 100 },
  "today": {
    "valuate":       { "used": 47, "limit": 1000, "remaining": 953 },
    "batch_valuate": { "used": 2,  "limit": 50,   "remaining": 48  },
    "price_index":   { "used": 12, "limit": 100,  "remaining": 88  }
  },
  "history": [
    { "date": "2026-03-28", "counts": { "valuate": 88, "batch_valuate": 3 }, "total": 91 },
    { "date": "2026-03-29", "counts": { "valuate": 47, "batch_valuate": 2, "price_index": 12 }, "total": 61 }
  ]
}
```

---

## Ops Routes

The following routes require the `x-ops-secret` header (internal ops use only).

### POST `/api/ops/b2b/keys`

Create a new B2B API key.

**Body:**
```json
{ "orgId": "acme-corp", "orgName": "Acme Corporation", "tier": "growth", "notes": "..." }
```

**Response:** includes `rawKey` (shown once only), `keyId`, `tier`, `createdAt`.

### GET `/api/ops/b2b/keys`

List all API keys (metadata only — no raw keys). Query: `?includeRevoked=false` to
filter inactive keys.

### DELETE `/api/ops/b2b/keys/:keyId`

Revoke an API key. Usage history is retained for audit. The key is immediately
invalidated — in-flight requests using the key will fail on the next lookup.

### GET `/api/ops/b2b/usage`

Aggregate usage stats across all active keys — today's call counts by org.

### GET `/api/ops/b2b/usage/:keyId`

Detailed usage history for one key. Query: `?days=30` (default 30, max 35).

### GET `/api/ops/b2b/price-index/:category`

Ops view of a category price index, with cache bypass support.
Query: `?force=true` to bypass the 1h cache and recompute from raw samples.

---

## Price Index Seeding

The price index is built automatically from consumer scans. A category becomes
available after 10 price samples are recorded (roughly 10 consumer scans for that
category). The index is:

- Computed hourly (1h cache TTL)
- Based on the last 90 days of scan data (newest 500 samples per category)
- Grade A requires 100+ samples; Grade B requires 30+; Grade C requires 10+

There is no manual seeding endpoint — index quality reflects actual scan volume.

---

## Rate Limit Errors

```json
{
  "ok": false,
  "error": "b2b_rate_limit_exceeded",
  "endpoint": "valuate",
  "used": 100,
  "limit": 100,
  "tier": "starter",
  "resetAt": "2026-03-30T00:00:00.000Z"
}
```

HTTP status: `429`.
