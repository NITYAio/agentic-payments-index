# Direct-source indexing runbook

Status: independent collection and terminal-recipient normalization implemented;
rolling production cutover complete. MPP history is active from 2026-02-16 and
x402 history is active from 2025-05-09. Both histories and their identity/cohort
datasets are complete through the latest published UTC boundary.

## Launch scope

The first independently indexed release is intentionally narrow:

| Protocol | Network and asset | Primary evidence | Published unit | Explicit exclusions |
|---|---|---|---|---|
| x402 | Base USDC | SQD Portal's public Base event archive, filtered to the open facilitator-address registry; Base RPC resolves UTC timestamps to block boundaries | Facilitator-associated payments, counted once at the payer's original amount and attributed to the terminal recipient | Solana, Polygon, non-USDC assets, unresolved ownership, and quality adjustment for testing or speculative activity |
| MPP | Tempo pathUSD and USDC.e | Public Tempo JSON-RPC `TransferWithMemo` logs carrying the official MPP attribution tag | Distinct MPP-attributed protocol payments | Off-chain session vouchers, custom merchant memos, other assets, and older untagged clients |

x402 terminal-recipient classification and its audit measures are specified in
[`X402_TERMINAL_RECIPIENT_METHOD.md`](./X402_TERMINAL_RECIPIENT_METHOD.md).

The collectors never accept MPPScan or x402scan totals as primary activity evidence. Their public outputs may be used only for reconciliation. The x402 facilitator registry is vendored open metadata under its MIT license; Base activity is queried independently.

## Cost controls

- The daily x402 refresh reads Base events from SQD Portal in bounded UTC-day
  slices. Base RPC is used only to resolve date boundaries to block numbers.
  Coinbase CDP SQL is optional reconciliation evidence, not a production
  dependency. The scheduled job scans only the current 30-day publication
  range; the immutable all-time history is not needlessly rescanned.
- Tempo's public RPC is suitable for range verification but rate-limited during historical log scans. Tempo's official developer guide lists dRPC, Alchemy, Allium, and Goldsky as data partners. Use a dedicated dRPC archive endpoint for the backfill: try its free 210M-CU allowance first, and cap any paid month at $10 unless measured usage justifies a change.
- D1 stores daily aggregates and compact provenance—not millions of raw transfers. The launch footprint is negligible relative to the free 5 GB allowance.
- R2 is not required for launch. Add it later only for compressed raw-evidence archives.
- Set provider billing alerts before enabling any paid plan. Do not enable automatic uncapped RPC or BigQuery spend.

Expected public-beta infrastructure cost: **$0–$15 per month**: $0–$5 for the application and $0–$10 for a reliable Tempo endpoint. A paid Workers plan is optional at launch and starts at $5 per month. There is no required one-time infrastructure charge.

The scheduled refresh runs MPP and x402 in parallel. A final production check
requires both protocols to be current and the all-time histories to remain
complete. A failed or delayed protocol stays visibly stale; the workflow never
silently republishes an old value as current.

## Secret setup

Never paste credentials into GitHub, a pull request, Codex chat, or a committed `.env` file.

Create `.env.local` from `.env.example` and keep real values there. The file is ignored by Git, and `npm run direct:collect` loads it automatically.

```bash
cp .env.example .env.local
```

1. Create a Base Mainnet RPC endpoint and store it as `BASE_RPC_URL`. It is used
   for timestamp-to-block resolution, not for full-chain event scanning.
2. Create a Tempo archive endpoint and store it as `TEMPO_RPC_URL`.
3. Generate a high-entropy `DIRECT_SOURCE_INGEST_TOKEN` and configure the same
   value as a production secret and in the trusted collector environment.
4. Set `DIRECT_SOURCE_INGEST_URL` to
   `https://agenticpaymentsindex.org/api/internal/direct-source-ingest`.
5. Keep `CDP_CLIENT_API_KEY` only if Coinbase SQL is used for optional
   reconciliation. It is not required by the daily production refresh.

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

Refresh the exact rolling windows and then audit production freshness:

```bash
REFRESH_PROTOCOLS=mpp npm run direct:refresh
npm run direct:refresh:x402
npm run data:freshness
```

`REFRESH_PROTOCOLS` is explicit so the MPP collector cannot begin consuming an
unexpected provider by accident. The x402 command names its SQD source in the
script and publishes only after all 30 daily slices reconcile.

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
- Configure the Base and Tempo RPC credentials locally without sharing them.
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
