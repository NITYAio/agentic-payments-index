# Data sources and contributions

The Agentic Payments Index is an evidence layer, not the owner of the upstream
facts it observes. Application code is Apache-2.0 licensed; that licence does
not relicense data, names, logos, or editorial content supplied by third parties.

## Current production sources

| Protocol | Source | Used for | Current state |
|---|---|---|---|
| MPP | [MPPScan](https://mppscan.com) | Aggregates, time buckets, payer and recipient counts, paginated service records | Raw observed activity |
| x402 | [x402scan](https://www.x402scan.com) | Aggregates, time buckets, payer and recipient counts, paginated service records | Raw observed activity |

The index records the source, retrieval time, requested window, and material
coverage limit with every normalized result. It does not silently combine
incompatible definitions or infer an autonomous agent from a wallet address.

## Known reconciliation work

The 30-day headline totals shown by x402.org and x402scan have differed
materially. The live application currently uses x402scan consistently across
its cards and charts. The x402.org figures are not substituted into individual
metrics until their chain, facilitator, status, time-boundary, and identity
definitions can be reproduced. See the public roadmap issue for the audit.

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
