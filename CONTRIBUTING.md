# Contributing

Thank you for helping make agent-payment data more accurate, explainable, and
useful.

## Principles

1. Evidence beats narrative.
2. Raw activity, resolved entities, and adjusted activity are separate states.
3. Every metric needs a source, time window, formula, freshness stamp, and
   limitation.
4. A smaller defensible number is preferable to a larger ambiguous one.
5. Protocol teams may contribute, but they do not receive preferential
   placement or methodology.

## Good contributions

- Add or repair a public data adapter.
- Reproduce a discrepancy between the index and an upstream source.
- Improve service-origin or cross-protocol entity resolution.
- Add a test for a metric, parser, time window, or pagination boundary.
- Propose an organic-activity heuristic with documented false positives and
  false negatives.
- Improve keyboard access, mobile behavior, or data visualization.

## Data corrections

Include:

- the affected protocol and metric;
- the exact time window and UTC timestamp;
- the index URL or API request;
- the upstream source URL or transaction evidence;
- expected and observed values;
- a reproducible explanation.

Do not include private keys, API credentials, personal information, or
non-public customer data.

## Pull requests

1. Keep each change focused.
2. Add or update tests when behavior changes.
3. Update the methodology when a definition, source, or transformation changes.
4. Run `npm run build` and `npm test`.
5. Explain the user-visible effect and any remaining coverage limitation.

Maintainers may request additional evidence, split a contribution, or decline a
methodology change that cannot be reproduced.

## Governance

The founder and maintainers approve releases and methodology versions.
Contributors do not receive production access by submitting code. Material
changes to adjustment rules should be proposed publicly before they become the
default.
