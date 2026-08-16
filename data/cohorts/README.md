# Cohort snapshots

These checked-in files are compact, aggregate outputs of the privacy-preserving identity backfill. They contain cohort sizes and retained counts only—no raw wallet addresses, credentials, service identifiers, or hashed identities.

Each snapshot records its exact source coverage and the latest completed calendar month. Production ingests the same files through the authenticated cohort-snapshot endpoint. The generation method is documented in [`docs/identity-data-layer.md`](../../docs/identity-data-layer.md).

Current launch coverage:

- MPP: 2026-02-16 through 2026-08-10
- x402: 2025-05-09 through 2026-08-10
- Complete retention months: through 2026-07
