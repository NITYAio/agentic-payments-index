# x402 terminal-recipient reconciliation — 2026-08-16

Status: **terminal-recipient normalization complete for the rolling 24-hour,
7-day, and 30-day launch windows**.

## What changed

The earlier collector counted distinct transactions but summed every Base USDC
transfer event inside them. That did not usually duplicate the transaction
count, but it could count the same payment value again as funds passed through a
router and could label routers or fee addresses as recipients.

The corrected measure follows ordered receive-and-forward chains to the final
recipient. Each payer-originated payment is counted once at the payer's original
amount. Terminal-recipient net value, all raw transfer legs, and gross transfer
movement remain available as audit measures; they are not headline payment
volume. The complete rule is in
[`X402_TERMINAL_RECIPIENT_METHOD.md`](./X402_TERMINAL_RECIPIENT_METHOD.md).

## Corrected direct-source windows

All three windows end at `2026-08-16T04:43:29Z` and use Base USDC events
submitted by the versioned public facilitator registry.

| Window | Payments | Raw transfer legs | Payment value | Terminal recipients received | Gross transfer movement | Payers | Final recipients |
|---|---:|---:|---:|---:|---:|---:|---:|
| 24 hours | 417,077 | 431,434 | $38,244.69 | $38,142.98 | $48,331.05 | 2,480 | 1,736 |
| 7 days | 2,111,339 | 2,200,981 | $312,487.54 | $311,787.80 | $381,888.67 | 9,730 | 9,031 |
| 30 days | 7,133,096 | 7,425,074 | $902,642.52 | $899,927.45 | $1,172,555.73 | 18,666 | 47,664 |

Had gross transfer movement been mislabeled as payment value, the overstatement
would have been 26.37% for 24 hours, 22.21% for 7 days, and 29.90% for 30 days.
The correction therefore materially changes the number users would interpret as
economic payment volume.

## Public-explorer comparison

x402scan's Base-only rolling results were captured at
`2026-08-16T05:05:49Z`, about 22 minutes after the direct windows ended. Its API
does not expose a historical end-time parameter, so these are close-boundary
reconciliation checks rather than perfectly identical extracts.

| Window | Index payments | x402scan transactions | Delta | Index payment value | x402scan amount | Delta |
|---|---:|---:|---:|---:|---:|---:|
| 24 hours | 417,077 | 416,217 | +0.21% | $38,244.69 | $37,833.44 | +1.09% |
| 7 days | 2,111,339 | 2,050,340 | +2.98% | $312,487.54 | $304,495.32 | +2.62% |
| 30 days | 7,133,096 | 6,882,956 | +3.63% | $902,642.52 | $879,065.29 | +2.68% |

The remaining differences are small enough for reconciliation but are not
silently blended away. Plausible contributors are the 22-minute boundary
difference, facilitator-registry version, and classifier behavior for fan-out
or unmatched legs. The Index publishes its independent direct result and keeps
x402scan only as a named cross-check.

## Reproducibility

| Window | Query hash | Raw input rows |
|---|---|---:|
| 24 hours | `f0398eafefb69e1ac4948a2fa11758dab9057507c6aca838d8e25872c546251a` | 431,434 |
| 7 days | `15c52558a3872f6f65735f7dbab2740ab189f52e174846d5b0a1483b05a51b80` | 2,200,981 |
| 30 days | `40a2bf4cce54b2d5de0a337901642cce57144d0cb2017ce2d98ec84cecf367c6` | 7,425,074 |

The collector also excludes event rows marked as removed by chain
reorganization. A separate three-hour benchmark returned identical normalized
results through both the direct indexed event query and an independent
transaction-join retrieval path.

## Remaining evidence boundary

- The result is Base USDC activity submitted by the versioned facilitator
  registry, not every network, asset, or x402 implementation.
- Structural routing normalization does not remove testing, self-payments, or
  activity whose real-world owner is unresolved.
- An address is an onchain identity, not proof of one person, company, or
  autonomous agent.
- x402 recipient cohort retention remains unavailable until historical identity
  segments have been rebuilt with this same terminal-recipient classifier.

## Public references

- https://www.x402scan.com/
- https://github.com/Merit-Systems/x402scan
- https://docs.x402.org/
