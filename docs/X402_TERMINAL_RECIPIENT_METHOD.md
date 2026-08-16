# x402 terminal-recipient normalization

Status: implemented and under rolling-window reconciliation on 2026-08-16.

## Why this exists

A facilitator-submitted Base transaction can emit more than one USDC `Transfer`
event. Summing every event measures gross onchain movement, not necessarily the
economic payment. It can count the same dollar again when a recipient forwards
funds through a proxy or routing contract.

## Public payment measure

For each ordered transaction:

1. Read Base USDC transfer legs in `log_index` order.
2. Find an origin leg whose sender did not first receive funds in that same
   transaction.
3. When the recipient later forwards funds, follow the outgoing leg whose amount
   is closest to the incoming amount.
4. Continue until the funds reach a recipient that does not forward them again.
5. Count one payment at the origin payer's amount and attribute it to that
   terminal recipient.

Unmatched fee or fan-out legs do not become additional payments.

## Values retained

- `volume_usd_micros`: payer-originated payment value, counted once. This is the
  public headline value.
- `recipient_volume_usd_micros`: value delivered to terminal recipients.
- `gross_volume_usd_micros`: sum of every raw USDC transfer leg, retained for
  audit and reconciliation.
- `raw_transfer_count`: number of underlying USDC transfer events.

Example: payer sends $100 to a router, which sends $99 to the merchant and $1 to
a fee address. The Index reports one $100 payment, $99 received by the terminal
recipient, and $200 of gross transfer movement across three raw legs.

## Evidence boundary

This is structural transfer normalization, not a claim that all observed
activity is organic commerce. Testing, self-payments, unresolved ownership,
unsupported facilitators, other assets, and non-Base activity remain outside the
current quality adjustment. The public methodology must show those limitations.

The x402 exact EVM specification provides the underlying payer, recipient, and
authorized value semantics. The Index independently reconstructs the terminal
recipient from direct Base logs and retains the uncollapsed evidence rather than
depending on an explorer's aggregate.

Seller-side x402 and combined cohort retention remains gated until this same
terminal-recipient classifier has replaced the earlier historical identity
segments. Payer cohorts are unaffected by recipient routing.
