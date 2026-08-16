# Direct-source reconciliation — 2026-08-10

> Historical audit record. This pre-normalization report is superseded by
> [`RECONCILIATION_2026-08-16.md`](./RECONCILIATION_2026-08-16.md). Do not use
> its x402 gross transfer value as payment volume.

Status: **backfill and fixed-window identity summaries complete; public cutover
blocked on value classification, recipient resolution, and preview approval**.

## Comparable direct window

The independent backfill covers the 30 complete UTC days from
`2026-07-10T00:00:00Z` through `2026-08-09T00:00:00Z` (exclusive).

| Protocol | Direct measurement | Transactions | USD volume | Evidence file |
|---|---|---:|---:|---|
| x402 | Distinct Base transactions submitted by the versioned facilitator registry and containing Base USDC transfers | 9,397,514 | $981,035.60 raw transfer volume | `data/backfills/x402-2026-07-10_2026-08-09.json` |
| MPP | Tempo `TransferWithMemo` payments in pathUSD or USDC.e carrying the official MPP attribution tag | 614,790 | $95,148.29 | `data/backfills/mpp-2026-07-10_2026-08-09.json` |

The x402 volume is deliberately called **raw transfer volume**, not payment
volume. Transactions with proxy or pass-through legs can contain more than one
USDC transfer. No silent leg-selection heuristic has been applied.

## Period-wide identity summaries

These counts deduplicate addresses across the complete 30-day window. They are
not sums of daily unique counts.

| Protocol | Payer addresses | Recipient addresses | What the count does not prove |
|---|---:|---:|---|
| x402 | 15,742 | 73,534 | A wallet address is not necessarily one person, autonomous agent, service, or company. |
| MPP | 43,831 | 15,618 | A recipient address is not a resolved MPP server or named directory origin. |

The MPP recipient-address total is materially broader than MPPScan's rolling
`uniqueRecipients` figure of 1,206. The Tempo event ABI and payer/recipient
topic positions have been verified against the official `TransferWithMemo`
specification, so the direct result is retained as **raw recipient addresses**.
It will not be relabelled as active servers. Resolving those addresses to
service identities is a separate entity-resolution layer.

## Rolling public-index check

The following public figures were read at `2026-08-10T03:30:38Z`. They are
rolling windows, so they do not have the same boundary as the complete-day
direct backfill. Deltas are diagnostic, not claims that one source is wrong.

| Protocol/source | Transactions | USD volume | Direct delta | Interpretation |
|---|---:|---:|---:|---|
| x402scan, rolling 30d | 9,320,942 | $861,516.08 | +0.82% transactions; +13.87% volume | Transaction counts are closely aligned. The volume delta is consistent with the direct query summing every USDC transfer leg plus a rolling-window mismatch; it is not yet an adjusted payment-volume comparison. |
| MPPScan, rolling 30d | 732,888 | $101,069.94 | -16.11% transactions; -5.86% volume | The direct collector intentionally includes only the official attribution memo and two named Tempo assets. Exact MPPScan inclusion rules and the rolling-window mismatch remain to be reconciled. |
| x402.org headline, rolling 30d | 75.41M | $24.24M | -87.54% transactions; -95.95% volume | Not comparable today. The headline does not expose a reproducible network, asset, facilitator, settlement-scheme, or adjustment definition. Official x402 documentation supports multiple network families and token types, so broader coverage is possible, but that is an inference—not a verified explanation of this headline. |

## Evidence gates

- Both direct files contain all 30 days and no missing or synthetic zero days.
- x402 query hash: `5aee3ff4ad712754e9c4cdf212e3ba6c0edb81c56efd79f558a2678f80dbc09b`.
- MPP query hash: `d24e1b7e682e21851703eda98d7da8d8e9c824f38762e6bbe2c6c4336df4e8fb`.
- Period-wide payer and recipient counts are stored separately from daily chart
  context. Daily unique counts are never added to calculate a window total.
- The direct totals remain unadjusted and will be labeled that way in every
  public surface.

## Cutover decisions

1. Publish direct transaction counts with the exact network, asset, and
   attribution boundaries above.
2. Label x402 transfer value as raw until unambiguous payment legs can be
   classified; do not present it as adjusted payment volume.
3. Publish period-wide distinct payer and recipient addresses only under those
   names. Do not call raw recipients services, servers, or companies.
4. Keep x402.org, x402scan, and MPPScan as separately named reconciliation
   references, never blended into the direct totals.
5. Ask the x402 Foundation and Merit Systems for their exact headline inclusion
   rules and fixed-window extracts.
6. Add a separate address-to-service resolution table before publishing active
   server or company counts from direct settlement evidence.

## Public references

- https://x402.org/
- https://docs.x402.org/core-concepts/network-and-token-support
- https://docs.tempo.xyz/guide/payments/transfer-memos
- https://docs.tempo.xyz/protocol/tip20/spec
- https://www.x402scan.com/
- https://mppscan.com/
