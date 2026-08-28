# Identity data layer

The Agentic Payments Index calculates retention only from stable, independently supported payment identities. Rolling aggregate counts are never reconstructed into synthetic cohorts.

## Why this layer exists

MPPScan and x402scan provide useful market aggregates, but aggregate unique-payer totals cannot tell whether the same identity returned in a later month. Retention requires an identity history.

The identity layer therefore stores monthly activity facts derived from verified payment evidence. It does not store raw payer or payee identifiers. Each identity is normalized within its protocol and network scope, then SHA-256 hashed locally before historical artifacts are written or data reaches D1.

## Accepted evidence

### MPP

The strongest input is a verified MPP Credential source identity paired with a successful MPP Receipt. The Receipt links the payment to a method-specific reference and timestamp. For MPP sessions, per-request or voucher receipts are required because channel open/close transactions alone do not represent every paid interaction.

Official references:

- https://mpp.dev/advanced/identity
- https://mpp.dev/protocol/receipts
- https://mpp.dev/payment-methods/tempo/charge

### x402

The strongest input is a successful facilitator settlement response paired with the accepted payment requirements and a confirmed network reference. The settlement response identifies the payer, network, success state, and transaction reference. A direct-chain settlement is accepted only when protocol attribution is deterministic—for example through a verified facilitator flow, signed receipt, or protocol attribution extension.

Official references:

- https://docs.x402.org/core-concepts/facilitator
- https://docs.x402.org/schemes/exact
- https://docs.x402.org/extensions/builder-code

### Excluded

- Ordinary stablecoin transfers with no defensible MPP or x402 attribution
- Rolling or bucketed unique-payer totals
- Failed, unconfirmed, or replayed settlements
- Declared and inferred identities in verified retention calculations

## Storage model

`identity_ingestion_segments` records immutable source partitions, cursors, date coverage, checksums, evidence type, and import state.

`monthly_identity_activity` stores segment-scoped payer and payee activity by protocol, network, identity hash, calendar month, transaction count, USD micros, and evidence level.

`cohort_snapshot_runs` and `cohort_snapshot_cells` store the exact aggregate retention matrix used by the public application. They contain cohort sizes and retained counts only—never raw or hashed identities. The latest complete snapshot supersedes the prior public snapshot without deleting its audit record.

Segments are idempotent. Replaying the same segment and checksum has no effect. Reusing a segment id with different contents is rejected.

The historical collector retains hashed identity-month evidence outside the public application, calculates exact intersections locally, and publishes only the compact cohort snapshot. This keeps public queries fast and preserves the side-project cost target without exposing a pseudonymous identity graph.

## Cohort definitions

- **Activity cohort:** every identity active in the selected month. Retention is the percentage active again in M+1, M+2, and later completed months.
- **Acquisition cohort:** identities first observed in the selected month. A cohort beginning in the first covered month is marked left-censored because earlier activity is unknown.
- **Payer retention:** uses the verified payer identity.
- **Service retention:** uses the verified payee or service identity.

The current partial month is excluded. Combined MPP + x402 cohorts do not deduplicate identities across protocols or networks unless an independently verified identity link is later available.

## Operational ingestion

The trusted collector sends normalized segments to `/api/internal/identity-ingest` using a bearer secret stored in the hosting environment. A segment accepts either raw normalized events that are hashed inside the Worker, or up to 1,000 locally hashed monthly identity rows. Historical collection uses the latter mode so raw identities never appear in saved artifacts or cross the ingestion boundary.

Privacy-preserving history collection is available for both protocols:

```bash
npm run identity:collect -- --protocol mpp --from 2026-02-16 --to 2026-08-11 --no-ingest
npm run identity:collect -- --protocol x402 --from 2025-05-09 --to 2026-08-11 --no-ingest
```

Generated identity-history files are deliberately gitignored. They can be audited locally, ingested, and discarded without publishing pseudonymous activity histories in the open-source repository.

To turn completed MPP and x402 manifests into compact, production-ready snapshots:

```bash
npm run cohort:snapshot -- \
  --mpp-manifest /private/tmp/mpp-manifest.json \
  --x402-manifest /private/tmp/x402-manifest.json \
  --no-ingest
```

The production collector posts each generated snapshot to `/api/internal/cohort-snapshot-ingest` with the same identity-ingestion bearer secret. Snapshot ingestion is immutable and idempotent; only the latest complete snapshot for each protocol scope is served.

To ingest an already normalized segment:

```bash
IDENTITY_INGEST_TOKEN=... npm run identity:ingest -- ./segment.json
```

The public read endpoint is `/api/cohorts`. The Ask endpoint uses the same calculation engine and returns a cohort heatmap when coverage exists.
