# Direct-source indexing runbook

Status: implementation complete; credentials, backfill, reconciliation, and production cutover pending.

## Launch scope

The first independently indexed release is intentionally narrow:

| Protocol | Network and asset | Primary evidence | Published unit | Explicit exclusions |
|---|---|---|---|---|
| x402 | Base USDC | Coinbase CDP SQL over Base events, filtered to the open facilitator-address registry | Distinct facilitator-submitted onchain settlements | Solana, Polygon, non-USDC assets, and quality adjustment of proxy transfer legs |
| MPP | Tempo pathUSD and USDC.e | Public Tempo JSON-RPC `TransferWithMemo` logs carrying the official MPP attribution tag | Distinct MPP-attributed protocol payments | Off-chain session vouchers, custom merchant memos, other assets, and older untagged clients |

The collectors never accept MPPScan or x402scan totals as primary activity evidence. Their public outputs may be used only for reconciliation. The x402 facilitator registry is vendored open metadata under its MIT license; Base activity is queried independently.

## Cost controls

- Coinbase CDP SQL includes 1,000 queries each month. The daily aggregate collector uses approximately 30 queries per month; the initial 30-day backfill uses one query.
- Tempo's public RPC is suitable for range verification but rate-limited during historical log scans. Tempo's official developer guide lists dRPC, Alchemy, Allium, and Goldsky as data partners. Use a dedicated dRPC archive endpoint for the backfill: try its free 210M-CU allowance first, and cap any paid month at $10 unless measured usage justifies a change.
- D1 stores daily aggregates and compact provenance—not millions of raw transfers. The launch footprint is negligible relative to the free 5 GB allowance.
- R2 is not required for launch. Add it later only for compressed raw-evidence archives.
- Set provider billing alerts before enabling any paid plan. Do not enable automatic uncapped RPC or BigQuery spend.

Expected public-beta infrastructure cost: **$0–$15 per month**: $0–$5 for the application and $0–$10 for a reliable Tempo endpoint. A paid Workers plan is optional at launch and starts at $5 per month. There is no required one-time infrastructure charge.

## Secret setup

Never paste credentials into GitHub, a pull request, Codex chat, or a committed `.env` file.

Create `.env.local` from `.env.example` and keep real values there. The file is ignored by Git, and `npm run direct:collect` loads it automatically.

```bash
cp .env.example .env.local
```

1. Create a free Coinbase Developer Platform project and Client API key for the SQL API.
2. Create a free dRPC Tempo archive endpoint. Upgrade only if a measured backfill exhausts the free allowance, and set a $10 budget cap first.
3. Store `CDP_CLIENT_API_KEY` and `TEMPO_RPC_URL` only in the collector environment.
4. Generate a high-entropy `DIRECT_SOURCE_INGEST_TOKEN` and configure the same value as a production secret and in the trusted collector environment.
5. Set `DIRECT_SOURCE_INGEST_URL` to `https://agenticpaymentsindex.org/api/internal/direct-source-ingest` after the migration is deployed.

## Commands

Dry-run x402 query construction without making a paid query:

```bash
npm run direct:collect -- --protocol x402 --from 2026-07-09 --to 2026-08-08 --dry-run
```

Verify the MPP block range against Tempo before running the archive scan:

```bash
npm run direct:collect -- --protocol mpp --from 2026-08-07 --to 2026-08-08 --dry-run
```

Run and ingest a backfill after secrets and the D1 migration are deployed:

```bash
npm run direct:collect -- --protocol x402 --from 2026-07-09 --to 2026-08-08
npm run direct:collect -- --protocol mpp --from 2026-07-09 --to 2026-08-08 --chunk-size 10000 --rpc-delay-ms 100
```

Preserve local evidence without calling the ingestion endpoint:

```bash
npm run direct:collect -- --protocol x402 --from 2026-07-10 --to 2026-08-09 --no-ingest --output data/backfills/x402-2026-07-10_2026-08-09.json
npm run direct:collect -- --protocol mpp --from 2026-07-10 --to 2026-08-09 --chunk-size 10000 --rpc-delay-ms 100 --no-ingest --output data/backfills/mpp-2026-07-10_2026-08-09.json
```

Ingest an already reviewed artifact without querying the chain again:

```bash
npm run direct:collect -- --evidence data/backfills/x402-2026-07-10_2026-08-09.json --ingest-url http://localhost:3000/api/internal/direct-source-ingest --output /tmp/x402-ingest-result.json
```

This command reads `DIRECT_SOURCE_INGEST_TOKEN` from `.env.local`, sends the
checked artifact through the authenticated ingestion endpoint, and never prints
the token.

The endpoint is idempotent. Replaying the same immutable run key and query hash returns the existing completed run; changing the query under the same run key is rejected.

## Reconciliation gates

Do not switch the homepage to the new aggregates until all gates pass:

1. The source query, address registry version, range, row count, and SHA-256 query hash are retained.
2. Every day in the selected range is present, including explicit zero-activity days.
3. Direct x402 results are compared separately with x402.org and x402scan. Deltas are explained by coverage, timing, facilitator registry, batching, or unadjusted proxy paths—not averaged away.
4. Direct MPP tagged charges are compared with MPPScan, while making clear that MPPScan may include untagged charges or off-chain request activity the chain cannot reveal.
5. Desktop and mobile views show the source, measurement unit, last successful sync, coverage start, and limitation.
6. Questions that require session-level interactions, autonomous-execution proof, or unsupported networks return an evidence boundary rather than an estimate.

## Three-day launch sequence

### Day 1 — Evidence and backfill

- Deploy migration `0004` to the preview database.
- Configure the Coinbase and dRPC credentials locally without sharing them.
- Run the 30-day x402 and MPP backfills.
- Review daily totals, gaps, first/last timestamps, and query provenance.

### Day 2 — Reconciliation and product cutover

- Write a short reconciliation note for each material upstream delta.
- Read the homepage, charts, protocol toggles, Ask results, and coverage page from the direct aggregate API.
- Keep incompatible units separate: MPP attributed payments are not silently summed with x402 settlements unless the UI names the combined unit and its limitations.
- Run the question-quality suite and desktop/mobile browser QA.

### Day 3 — Final review and public beta

- Preview with the owner and resolve only launch-blocking defects.
- Confirm freshness monitoring and a rollback path.
- Merge the reviewed pull request and publish the public beta.
- Announce it as a precise beta with published coverage boundaries, not as complete market coverage.
