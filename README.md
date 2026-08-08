# The Agentic Payments Index

**The machine economy, made legible.**

The Agentic Payments Index is an open evidence layer for machine-native
stablecoin payments. It combines MPP and x402 activity, makes resolved services
browsable across every source page, and answers analytical questions with the
formula, provenance, and material coverage limitation attached.

Created by **Nityanand Sharma, founder of Simpl**, as an independent side
project for operators, investors, researchers, protocol teams, and journalists.
Read the public [About page](https://agenticpaymentsindex.org/about) and
[protocol coverage map](https://agenticpaymentsindex.org/coverage).

## What the index publishes

- Protocol-level 24-hour, 7-day, 30-day, and available-history payment aggregates.
- MPP and x402 views plus a clearly disclosed combined view.
- Complete paginated resolved-service directories for the selected window.
- A live analysis endpoint for totals, averages, protocol comparisons, trends,
  rankings, concentration, and measured anomalies.
- Explicit evidence-gated responses for cohorts, wallet attribution, and
  autonomous execution when identity-level data is not yet available.
- Active payer addresses and active server identities, never relabelled as
  people, companies, or autonomous agents without supporting evidence.
- A persistent service-submission flow with domain-control and endpoint checks.
- An open wallet-attribution registry with confidence states.
- A Human interface and a Machine interface backed by public JSON endpoints.
- Explicit metric states: raw, resolved, and quality-adjusted.
- Reproducible live-answer links and downloadable insight cards for verified calculations.

Quality-adjusted activity is not yet applied. Current totals may include
testing, internal settlement, unresolved counterparties, or other inorganic
activity. The interface labels this instead of implying that every observed
transaction represents independent economic demand.

## Public data sources

- [MPPScan](https://mppscan.com) for MPP aggregates, buckets, and resolved
  server origins.
- [x402scan](https://www.x402scan.com) for x402 aggregates, buckets, and Bazaar
  service origins.

The project is independent and is not affiliated with either index. Source
availability, definitions, and upstream corrections can change the displayed
results.

Read [DATA.md](DATA.md) for source acceptance, reconciliation, licensing, and
submission rules. The Apache-2.0 code licence does not relicense upstream data,
names, logos, or editorial content.

## Machine-readable endpoints

- `GET /api/network` — aggregates and time-series buckets.
- `GET /api/services` — paginated service origins.
- `POST /api/ask` — deterministic, evidence-aware question answering.
- `GET /api/wallets` — wallet attribution registry and coverage state.
- `POST /api/submissions` — service verification challenge creation.
- `POST /api/submissions/verify` — domain and endpoint verification.
- `GET /api/agent` — machine manifest, field states, provenance, and endpoint
  contract.

The service endpoint accepts:

| Parameter | Values |
|---|---|
| `protocol` | `all`, `mpp`, `x402` |
| `days` | `0` (all available history), `1`, `7`, `30` |
| `sort` | `transactions`, `volume`, `buyers` |
| `page` | integer starting at `1` |
| `pageSize` | integer from `10` to `50` |

## Local development

Requirements: Node.js `>=22.13.0`.

```bash
npm install
npm run dev
npm run build
npm test
```

## Contributing

Contributions are welcome, especially:

- data-source corrections and discrepancy reports;
- protocol adapters;
- entity-resolution rules;
- reproducible quality-adjustment heuristics;
- accessibility and visualization improvements;
- source-backed research notes.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/METHODOLOGY.md](docs/METHODOLOGY.md) before opening a pull request. The
approved vNext product contract is in [docs/VNEXT_SPEC.md](docs/VNEXT_SPEC.md).
Use the structured issue forms for data sources, corrections, methodology, and
protocol coverage; use Discussions for open-ended research debate.

## License

Code is licensed under the [Apache License 2.0](LICENSE). The project name and
visual identity are not granted as trademarks by that license.
