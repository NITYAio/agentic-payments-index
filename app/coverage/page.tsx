/* eslint-disable @next/next/no-html-link-for-pages */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Protocol coverage — The Agentic Payments Index",
  description: "What each agentic commerce and payment protocol publishes, what the Index measures, and what remains unavailable.",
  alternates: { canonical: "/coverage" },
};

const protocols = [
  {
    name: "MPP",
    role: "Machine-native payment protocol",
    measurement: "Direct observation · public beta",
    disclosure: "The Index reads current-version MPP charges and settled session events directly from Tempo. Invalid or older memos and unsettled vouchers are excluded. The result is protocol-attributed payment activity, before quality adjustment.",
    source: "https://docs.tempo.xyz/guide/payments/transfer-memos",
  },
  {
    name: "x402",
    role: "HTTP-native payment standard",
    measurement: "Direct observation · public beta",
    disclosure: "The Index queries Base USDC events directly and matches a versioned public facilitator registry. Receive-and-forward chains count once at the payer's original amount and are attributed to the final recipient; recipient value and gross transfer movement are retained for audit.",
    source: "https://docs.cdp.coinbase.com/data/sql-api/welcome",
  },
  {
    name: "Virtuals ACP",
    role: "Agent job, escrow, and commerce protocol",
    measurement: "Tracked, not combined",
    disclosure: "Relevant commerce activity, but its job lifecycle is not directly equivalent to an MPP or x402 payment. No compatible public aggregate feed is indexed yet.",
    source: "https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol/acp-current-status",
  },
  {
    name: "AP2",
    role: "Authorization and mandate layer",
    measurement: "Context only",
    disclosure: "AP2 proves intent and authorization; it is not itself a settlement-volume index. No protocol-wide transaction totals are published for comparison.",
    source: "https://github.com/google-agentic-commerce/AP2",
  },
  {
    name: "UCP",
    role: "Commerce discovery and checkout standard",
    measurement: "Context only",
    disclosure: "UCP standardizes commerce workflows and can use AP2 for payments. It does not publish a comparable global settlement total.",
    source: "https://ucp.dev",
  },
  {
    name: "Nevermined",
    role: "Agent payments and access platform",
    measurement: "Tracked, not combined",
    disclosure: "Supports fiat, stablecoins, and x402 extensions. A separate adapter and overlap rules are required before adding activity without double counting x402.",
    source: "https://nevermined.ai/docs/getting-started/overview",
  },
  {
    name: "Skyfire",
    role: "Managed identity and payment network",
    measurement: "Tracked, not combined",
    disclosure: "Relevant agent-payment activity, but no compatible public aggregate feed is currently indexed.",
    source: "https://docs.skyfire.xyz",
  },
];

export default function CoveragePage() {
  return (
    <main className="editorialPage coveragePage">
      <nav className="editorialNav">
        <a href="/" className="brand">
          <span className="brandMark" aria-hidden="true"><i /><i /></span>
          <span>THE AGENTIC PAYMENTS INDEX</span>
        </a>
        <div><a href="/about">About</a><a href="/">Open the index ↗</a></div>
      </nav>

      <header className="editorialHero">
        <span className="sectionNumber">Coverage map · reviewed August 2026</span>
        <h1>What the market discloses—and what it does not.</h1>
        <p>
          “Agentic commerce” contains payment rails, authorization layers,
          checkout standards, job markets, and managed platforms. Combining
          their numbers without matching the unit of measurement would be misleading.
        </p>
      </header>

      <section className="coverageLegend" aria-label="Coverage rules">
        <article><span>Included</span><p>Repeatable direct-chain activity with protocol-specific definitions.</p></article>
        <article><span>Tracked</span><p>Sector-relevant activity awaiting a defensible adapter or overlap rules.</p></article>
        <article><span>Context</span><p>An enabling protocol, not a directly comparable transaction rail.</p></article>
      </section>

      <section className="coverageTableWrap">
        <table className="coverageTable">
          <thead><tr><th>Protocol</th><th>Sector role</th><th>Index status</th><th>Disclosure</th></tr></thead>
          <tbody>
            {protocols.map((item) => (
              <tr key={item.name}>
                <td><a href={item.source} target="_blank" rel="noreferrer">{item.name} ↗</a></td>
                <td>{item.role}</td>
                <td><span>{item.measurement}</span></td>
                <td>{item.disclosure}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="reconciliationNote">
        <span className="sectionNumber">Why there is no “Other” total yet</span>
        <h2>Coverage before aggregation.</h2>
        <p>
          “Other” becomes useful only when every included network exposes a
          comparable successful-payment event, settlement value, time window,
          and deduplication rule. Until then, the coverage map is more honest
          than a total that mixes jobs, authorizations, checkouts, and settlements.
        </p>
        <a href="https://github.com/NITYAio/agentic-payments-index/issues/new/choose" target="_blank" rel="noreferrer">Submit a missing source or protocol ↗</a>
      </section>

      <section className="reconciliationNote" id="trust-barometer-method">
        <span className="sectionNumber">Trust Barometer methodology</span>
        <h2>MPP and x402 ticket sizes are measured from direct protocol evidence.</h2>
        <p>
          The Trust Barometer includes protocol-attributed paid observations: MPP
          charges and settled sessions on Tempo, plus x402-authorized USDC settlements
          on Base. Zero-value and self-payments are excluded. Generic token mints and
          speculative USDC transfers do not match the protocol-event selection and are
          outside the result. Receive-then-forward x402 chains count once at the original
          payer amount and resolve to the terminal recipient.
        </p>
        <p>
          Seven- and 30-day views use exact rolling windows. The 90-day view is summed
          from verified daily history, and All uses each protocol’s widest verified
          history. Counts, value, averages, maxima, and threshold totals can be combined.
          Medians cannot be added, so the combined view does not fabricate one; select
          MPP or x402 to inspect an exact protocol median.
        </p>
        <p>
          “Agent ticket size” is a market shorthand and a trust proxy. A payment
          rail alone does not prove that an autonomous agent initiated a payment, and
          a large outlier does not by itself establish broad market trust.
        </p>
      </section>

      <footer className="editorialFooter">
        <span>All site timestamps use UTC</span>
        <a href="/">Back to the live index →</a>
      </footer>
    </main>
  );
}
