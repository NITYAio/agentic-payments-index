# The Agentic Payments Index — vNext specification

Status: approved for implementation  
Owner: Nityanand Sharma  
Updated: 2026-08-01

## Product promise

The Agentic Payments Index is the open evidence layer for machine-native stablecoin payments. It combines MPP and x402 in one consistent interface, lets a reader isolate either protocol, and answers analytical questions from observed data without inventing precision or causality.

The public headline remains **“The machine economy, made legible.”** “Agentic GDP” is not used as the primary label because an MPP or x402 payment can be initiated by a person, an application, or an autonomous agent. Protocol use is not proof of autonomy.

## vNext product surface

### Global controls

- Protocol: All protocols / MPP / x402.
- Time: 24h / 7d / 30d / All.
- Protocol and time selections apply to every metric, chart, evidence card, directory result, machine-readable endpoint, and question unless the question explicitly names a different protocol or period.
- “All” means all history exposed by the current index, with the first observed timestamp disclosed. It must never imply protocol genesis unless coverage is complete.

### Human view

- High-end editorial interface: dark espresso, cream, orange-red; green is reserved for healthy live or verified states.
- Rounded controls and cards, restrained motion, a visible live heartbeat, legible axes, accessible hover/focus definitions, and responsive desktop/mobile layouts.
- The first fold uses Version B: a prominent Ask the Index workspace beside an at-a-glance market overview.
- UTC appears once, quietly, as a global data convention. It is not repeated on every chart or tooltip.
- The explanatory section uses plain language and distinguishes observed protocol activity from inferred agent behavior.

### Machine view

- The Human / Machine toggle exposes the same selected snapshot as structured JSON.
- It publishes stable field names, sources, freshness, coverage limits, and public endpoints.

### Metrics and terminology

- **Transactions:** successful protocol-indexed payment events in the selected window.
- **USD volume:** recorded stablecoin settlement value in the selected window.
- **Average payment size:** USD volume divided by successful transactions.
- **Transaction velocity:** successful transactions divided by the length of the selected window. For All, the denominator is the available indexed-history span.
- **Active payer addresses:** distinct network-normalized payer addresses observed in the selected window. This is not a count of people or autonomous agents. One actor can use several addresses; several actors can share an address; combined protocol counts may overlap.
- **Active server identities:** distinct protocol recipient identities that received at least one observed payment in the selected window. This is not the service-directory count and not necessarily a count of companies.
- **Indexed service records:** named service origins available across all paginated source-directory pages. It is directory coverage, not the active-server metric.
- Service tables label their identity column **Payer addresses**, never “Agents.”
- Every non-obvious term has a small superscript information affordance with a hover/focus definition and, when useful, a formula and example.

## Ask the Index

Ask the Index is a deterministic data-analysis service, not a collection of prewritten answers.

### Supported now

- totals and averages;
- 24h, 7d, 30d, and available-history windows;
- MPP, x402, and combined views;
- protocol comparisons and shares;
- trend/growth calculations from observed time buckets;
- service rankings and concentration from indexed service records;
- dated spike/anomaly measurement.

Every answer includes the metric, protocol, period, formula or method, source context, and the limitation material to interpretation. A “why did this spike?” answer may identify measured contributors or magnitude; it must distinguish that from an externally verified cause.

### Coverage-gated analyses

The interface accepts questions about cohorts, wallet providers, and autonomous execution, but it must not fabricate an answer when identity-level history or attribution evidence is absent. It returns:

- what can and cannot currently be calculated;
- the exact missing evidence;
- the collection status;
- an adjacent query that can be answered now.

The production query pipeline is designed to send an LLM only a normalized plan and small deterministic result tables. Raw transactions never need to enter a model context. Repeated query plans and results are cacheable.

## Cohorts and identity

The target analyst surface supports:

- payer-network retention;
- payer-to-service retention;
- verified-service retention;
- recipient-address retention;
- weekly and monthly matrices;
- MPP, x402, and combined filters.

Seller cohorts use verified service identity where available; recipient-address cohorts remain a separate view. Historical cohorts require independently stored transaction-level identities and cannot be reconstructed from rolling unique-count aggregates.

## Wallet and autonomy intelligence

The open Wallet Attribution Registry separates:

- account type;
- wallet provider;
- facilitator or transaction-submission provider;
- attribution confidence: Verified / Deterministic / Declared / Inferred / Unknown.

Initial provider coverage tracks Coinbase developer wallets, Tempo wallets/passkeys, MetaMask smart or agent wallets, Privy, Crossmint, Safe, Turnkey, Circle, and Fireblocks. The UI reports both the share of all activity and the share of attributable activity. Community additions are accepted through the open-source repository with evidence.

Autonomy is classified separately as Verified autonomous / Agent-linked / Likely automated / Human-confirmed / Unknown. Existing onchain settlement alone usually cannot prove autonomy. A future signed Autonomy Attestation can add per-payment execution evidence; historical activity remains Unknown unless supporting evidence exists.

## Service submission and verification

The site includes a Submit a service flow:

1. Submit a service name, canonical URL, protocol, network, protocol endpoint, and contact email.
2. The Index issues a unique verification challenge.
3. The submitter publishes the challenge at `/.well-known/agentic-payments-index.json` on the submitted domain.
4. Verification checks domain control, a valid challenge, HTTPS reachability, and a live protocol endpoint.
5. Status moves through Submitted → Reachable → Verified → Active (or Inactive when ongoing checks fail).

Contact details are private operational data and are never returned by the public API.

## Data and provenance

### Current production coverage

- MPP aggregates and directory: MPPScan public analytics.
- x402 aggregates and directory: x402scan public analytics.
- Complete source pagination is used for service-directory totals.
- Current metrics are unadjusted observed activity and can include testing, internal traffic, and unresolved counterparties.

The site clearly credits and links the sources, publishes methodology, and does not reproduce source branding or proprietary editorial content. Public API availability is not treated as ownership of the upstream data; terms and access policies must be reviewed before commercial data resale.

### Independent indexing path

The long-term source of truth is direct read-only indexing from Tempo and supported x402 settlement networks, with upstream indexes retained for reconciliation. The storage design separates:

- normalized payment facts and aggregate query tables;
- service, wallet, and autonomy registries;
- indexer checkpoints and provenance;
- compressed raw archives for reproducibility.

Direct-chain results may only be labelled live after contract coverage, decoding, reorg handling, reconciliation, and backfill tests pass. Until then the live product discloses its public-index source dependency.

## Open source, IP, and API

- Application code remains Apache-2.0 licensed. The owner retains copyright while granting the licence permissions.
- The public repository contains contribution, methodology, security, and data-source guidance.
- Public read-only endpoints remain free in vNext. A paid API may later add higher limits, exports, alerts, or SLAs; underlying facts and methodology are not paywalled by default.
- A separate data licence must be chosen before distributing a bulk derived dataset.

## Cost and operations

- Operating ceiling: **$300/month**.
- Start with usage caps and alerts; do not depend on sponsor credits for viability.
- Primary cost drivers: hosting/egress, database size and reads, raw archive storage, RPC/indexing, and optional model calls.
- Store compact aggregates in the query database and compressed raw history in object storage once independent indexing begins.
- Log source freshness, query failures, verification failures, and budget thresholds.

## vNext acceptance criteria

1. Protocol selection changes every visible chart and metric; a single-protocol view never retains the other protocol’s series or legend.
2. 24h, 7d, 30d, and All work in overview, network, evidence, and service-directory views.
3. All displayed numbers are live, derived, or explicitly unavailable—never placeholders presented as facts.
4. Ask the Index answers supported query classes in real time and discloses unsupported evidence instead of guessing.
5. Query regression tests cover phrasing variants, protocol selection, all windows, comparisons, spikes, cohorts, wallets, and autonomy.
6. Service submissions persist, issue a challenge, and can be verified against the submitted domain.
7. Human and Machine views expose consistent selected data and provenance.
8. Desktop and mobile layouts have no clipped controls, overlapping axes, or illegible copy.
9. Build, lint, automated tests, endpoint smoke tests, and browser interaction checks pass before deployment.
