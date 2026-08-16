# Data sources and contributions

The Agentic Payments Index is an evidence layer, not the owner of the upstream
facts it observes. Application code is Apache-2.0 licensed; that licence does
not relicense data, names, logos, or editorial content supplied by third parties.

## Current production sources

| Protocol | Source | Used for | Current state |
|---|---|---|---|
| MPP | Tempo chain evidence | Current-version MPP charges, settled sessions, values, payer and server identities | Direct, unadjusted observation |
| x402 | Base USDC chain evidence + versioned facilitator registry | Facilitator-associated payments, payer value counted once, terminal recipients, recipient net value, and gross transfer movement | Direct structural normalization; quality filters remain unadjusted |
| Service directory | [MPPScan](https://mppscan.com) and [x402scan](https://www.x402scan.com) | Paginated named service origins only | Directory layer; not headline metrics |

The index records the source, retrieval time, requested window, and material
coverage limit with every normalized result. It does not silently combine
incompatible definitions or infer an autonomous agent from a wallet address.

## Known reconciliation work

Third-party x402 headline totals can differ because facilitator scope,
pass-through handling, time boundaries, and identity definitions differ. The
live application therefore publishes its independently reproducible Base
measurement and labels it facilitator-associated activity rather than silently
substituting another headline figure.

## Proposing a source

Open a **Data source** issue and include:

1. the protocol and its role in the payment or commerce flow;
2. the official specification and public data endpoint;
3. the unit of observation (payment, authorization, checkout, job, or settlement);
4. supported networks, assets, statuses, and time boundaries;
5. pagination, freshness, rate limits, and historical coverage;
6. licence or terms governing access and redistribution;
7. overlap risks with sources already indexed.

A source becomes comparable only when successful events, settlement value,
time windows, identity fields, and deduplication rules can be stated precisely.
Protocols without comparable public aggregates can still appear on the coverage
map without being added to a misleading “Other” total.

## Corrections and methodology

- Use **Data correction** for a reproducible discrepancy.
- Use **Methodology proposal** for a definition, classification, or adjustment rule.
- Use **Protocol coverage** for a missing network or disclosure.
- Use GitHub Discussions for open-ended methodology debate.

Never submit API keys, wallet secrets, private customer data, or information you
do not have the right to share. Contributors retain responsibility for the
legality and provenance of evidence they submit.
