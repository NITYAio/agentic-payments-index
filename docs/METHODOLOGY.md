# Methodology

Status: `0.2 — raw and resolved observation layer`

## Metric states

### Raw

Protocol-indexed successful transactions, USD value, sender identities,
recipient identities, and time-series buckets. Raw does not mean organic.

### Resolved

Recipient activity associated with a public service-origin record. One company
may operate multiple origins or recipients. A service active on MPP and x402
may appear once in each protocol directory.

### Adjusted

An estimate intended to remove or separately classify testing, internal
settlement, self-payment, duplicated economic value, and other inorganic
activity. Adjustment is not yet applied to the production totals.

## Current sources

| Protocol | Aggregates | Service records |
|---|---|---|
| MPP | MPPScan public analytics | MPPScan resolved server origins |
| x402 | x402scan public analytics | x402scan Bazaar origins |

For x402, the upstream Bazaar endpoint paginates recipient records before
grouping them into origins. The index therefore reads every upstream page,
regroups identical origin IDs, aggregates their activity, and only then applies
the public directory pagination. This prevents an origin split across source
pages from appearing as multiple services and avoids claiming that raw
recipient count is resolved-service count.

## Combined views

Transaction count and USD volume can be summed when both source metrics
represent successful payments in the same selected window. Sender and recipient
counts are protocol-level sums and can contain overlap.

Combined service totals are the sum of resolved MPP origins and regrouped x402
origins. A service indexed on both protocols may appear twice. The total is
therefore described as service records, not unique companies.

## Questions

The deterministic question layer currently supports:

- total payment volume;
- successful transaction count;
- average payment size;
- paying sender identities;
- recipient identities;
- leading services;
- MPP versus x402 comparisons;
- 24-hour, 7-day, and 30-day windows.

A request for a non-overlapping previous period is rejected rather than
silently compared with an overlapping rolling aggregate.

## Planned quality adjustment

Candidate signals include:

- linked payer and recipient ownership;
- circular or self-funded payment paths;
- burst and machine-timing patterns;
- payment and counterparty concentration;
- resolved versus anonymous recipients;
- repeat independent buyers;
- service availability and successful delivery evidence.

The model will publish raw and adjusted values together, include confidence
ranges, and document known false-positive and false-negative behavior.
