# MPP internal reconciliation — 2026-08-10

Status: internal working note. This is not a public data source or website copy.

## Outcome

The main discrepancy is now explained.

Our first direct-source collector counted one-shot MPP charge payments but did
not count MPP session settlements. MPPScan's recent bucket totals are best
reproduced by:

```text
MPP payments = valid charge payments + session Settled events
MPP USD volume = charge amount + session deltaPaid
```

The direct charge definition that best matches MPPScan is:

- Tempo `TransferWithMemo` event;
- current MPP attribution memo version `0x01`;
- pathUSD or USDC.e only;
- one logical payment per event;
- plus `Settled` events from Tempo's TIP-1034 channel reserve, using
  `deltaPaid` as the incremental session value.

## Evidence

MPPScan's 48 returned buckets were reconciled against Tempo over the exact same
block and timestamp boundaries.

| Measure | MPPScan buckets | Direct candidate | Difference |
|---|---:|---:|---:|
| Transactions: charges only | 735,243 | 615,300 | -119,943 (-16.31%) |
| Transactions: charges + settlements | 735,243 | 730,537 | -4,706 (-0.64%) |
| USD volume: charges only | $101,123.73 | $100,099.68 | -$1,024.05 (-1.01%) |
| USD volume: charges + settlement `deltaPaid` | $101,123.73 | $100,248.79 | -$874.94 (-0.87%) |

Session settlements explain 115,237 of the 119,943 missing transactions, or
96.1% of the original transaction-count gap.

The formula is stronger than the 30-day aggregate residual suggests. In five
recent complete MPPScan buckets, direct `charges + settlements` matched both
transaction count and USD volume exactly (to the displayed precision). Several
neighboring buckets differed by only 3–4 transactions. The remaining historical
residual is therefore more consistent with materialization/backfill drift or an
older indexer rule than with a missing payment class.

MPPScan itself returned two slightly different states in the same response:

- live headline: 735,353 transactions and $101,126.42;
- sum of returned buckets: 735,243 transactions and $101,123.73.

That 110-transaction / $2.69 internal difference confirms that its headline and
bucket materializations need not have the same freshness.

## Identity finding

The website's seller/service count is almost certainly based on the server
fingerprint embedded in the MPP attribution memo, not the raw recipient wallet.

| Identity concept | Direct count | MPPScan count |
|---|---:|---:|
| Raw recipient addresses | 15,618 | not comparable |
| MPP server fingerprints | 1,205 | 1,208 unique recipients |

The three-identity difference is only 0.25%. This resolves the earlier apparent
15,618-versus-1,208 contradiction. Production copy should call the direct field
`active server identities` and explain that it is a protocol fingerprint, not a
company and not necessarily unique across every deployment.

MPPScan's buyer count is also consistent with a union of charge senders and
session payers. The exact period-wide union should be stored by the production
collector rather than inferred from separately aggregated counts.

## Token finding

Three tokens carried valid version-1 MPP attribution memos:

| Token | Valid MPP events | Assumed USD value |
|---|---:|---:|
| USDC.e | 613,565 | $100,012.14 |
| pathUSD | 1,735 | $87.54 |
| NANOUSD | 9,813 | $10.00 |

NANOUSD is an onchain six-decimal TIP-20 named `NanoUSD`, but it is not in the
documented production allowlist and its 9,813 payments total only about $10.
MPPScan's recent exact matches exclude it. Keep it in a quarantined
`unclassified token` layer until the issuer, backing, intended environment, and
MPPScan inclusion rule are verified. Do not silently mix it into production USD
volume.

There were also 2,906 `TransferWithMemo` events whose memo was not a valid MPP
version-1 attribution memo. They should remain excluded from MPP counts.

## Window finding

The MPPScan 30-day response returned 48 source-native buckets covering about
711 hours at collection time, not one exact 720-hour interval. Its live headline
also updates independently from the bucket materialization.

The Agentic Payments Index should use exact rolling windows:

- 24 hours = `now - 24h` through `now`;
- 7 days = `now - 168h` through `now`;
- 30 days = `now - 720h` through `now`;
- all time = genesis/first observed event through `now`.

For reconciliation, compare source-native buckets only over their stated
boundaries. Do not make our public window imitate an approximate source bucket
window merely to force the headline numbers to match.

## Production recommendation

1. Extend the MPP collector to ingest both valid charge events and TIP-1034
   `Settled` events.
2. Use `deltaPaid`, never cumulative settlement fields, for session USD volume.
3. Store `payment_mode = charge | session` so users can query each class and the
   combined MPP total.
4. Keep the stablecoin allowlist explicit and versioned. Quarantine unknown
   tokens pending classification.
5. Store raw payer address, raw recipient address, MPP server fingerprint, and
   client fingerprint as separate identity fields.
6. Compute exact rolling windows from our own event table.
7. Keep MPPScan as an internal reconciliation reference, not a production data
   dependency.

## Remaining question for the MPP/Tempo team

Ask for the historical inclusion/version timeline and whether the public index
ever backfilled or changed its session/token filters. That is the narrow question
needed to explain the remaining 0.64% historical count residual; the core payment
formula no longer needs to be guessed.

## Reproducible artifact

- Machine-readable result: `data/reconciliation/mpp-internal-2026-08-10.json`
- Collector: `scripts/reconcile-mpp.mjs`
- No API key or RPC endpoint is stored in either file.
