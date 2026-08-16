# Methodology

Status: `0.3 — live aggregates, identity semantics, and evidence-gated analysis`

## Metric states

### Raw

Protocol-indexed successful transactions, USD value, payer addresses,
recipient addresses, and time-series buckets. Raw does not mean organic.

**Active payer addresses** are distinct network-normalized payer addresses in
the selected source and window. They are not unique people or verified agents.
One actor may use several addresses, several actors may share an address, and
combined protocol totals may overlap.

**Active recipient addresses** are distinct onchain recipient addresses paid in
the selected window. They are not the same as servers, named indexed service
records, or unique companies. One service may rotate or control several
addresses, and one address can represent shared infrastructure.

**Resolved service identities** require a separate, evidenced mapping from a
payment recipient to a verified service or directory origin. Raw chain events
do not provide that mapping by themselves.

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
| MPP | Tempo direct chain evidence | MPPScan resolved server origins |
| x402 | Base USDC direct chain evidence + versioned facilitator registry | x402scan Bazaar origins |

The public-beta homepage uses primary payment evidence for exact rolling
24-hour, 7-day, and 30-day windows:

- x402: Base USDC event data from Coinbase CDP SQL, filtered to a versioned,
  open facilitator-address registry. Ordered receive-and-forward chains count
  once at the payer-originated amount and resolve to the final recipient;
- MPP: current-version Tempo charges carrying valid official MPP memos for
  pathUSD and USDC.e, plus settled TIP-1034 session events.

The direct-source layer retains the query hash, collector version, time range,
input row count, daily aggregates, source URL, measurement unit, freshness,
and limitations. Unsettled off-chain vouchers are not counted. See
`docs/DIRECT_SOURCE_RUNBOOK.md`.

Payer and recipient counts for a selected window are deduplicated across the
entire window. Daily unique-address counts are retained for chart context but
are never summed, because a returning address would otherwise be counted more
than once.

For x402, the upstream Bazaar endpoint paginates recipient records before
grouping them into origins. The index therefore reads every upstream page,
regroups identical origin IDs, aggregates their activity, and only then applies
the public directory pagination. This prevents an origin split across source
pages from appearing as multiple services and avoids claiming that raw
recipient count is resolved-service count.

## Combined views

Transaction counts can be shown together as protocol-level observed activity.
MPP and x402 payment values are shown separately because they cover different
protocols and networks. x402 gross transfer movement is retained as an audit
field and is never substituted for payment value. Sender and recipient counts
are protocol-level sums and can contain overlap.

Combined service totals are the sum of resolved MPP origins and regrouped x402
origins. A service indexed on both protocols may appear twice. The total is
therefore described as service records, not unique companies.

## Questions

The deterministic question layer currently supports:

- total payment volume;
- successful transaction count;
- average payment size;
- active payer addresses;
- active recipient addresses;
- leading services;
- MPP versus x402 comparisons;
- within-window trend calculations;
- measured dated anomalies;
- 24-hour, 7-day, 30-day, and all available-history windows.

Identity-level cohort retention, wallet-provider share, and autonomous
execution are evidence-gated. The current aggregate feeds cannot support those
calculations, so the response names the missing evidence instead of estimating
it. A causal explanation for a spike is also withheld unless contributor or
external evidence supports it.

## Wallet and autonomy evidence

Wallet attribution keeps account type, wallet provider, and facilitator
separate. Each rule is labelled Verified, Deterministic, Declared, Inferred, or
Unknown. Provider share is not published until independently indexed payment
identities can be evaluated against the open registry.

Autonomous execution is a separate claim. MPP and x402 can be used by a person,
an application, or an agent. A payment remains Unknown unless signed execution
attestations or equivalent evidence justify a stronger classification.

## Service verification

Service submissions prove domain control by publishing a unique challenge at
`/.well-known/agentic-payments-index.json`. The verifier also checks HTTPS and
the submitted protocol endpoint. This proves control and reachability, not the
identity of a legal entity. Activation additionally requires observed activity
and maintainer review.

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
