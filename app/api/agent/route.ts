export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      name: "The Agentic Payments Index",
      slug: "the-agentic-payments-index",
      description:
        "An open evidence layer for machine-native stablecoin payments across MPP and x402.",
      schemaVersion: "0.4.0",
      release: {
        stage: "public-beta",
        discovery: "unlisted",
        identityHistory: "backfill-in-progress",
      },
      access: {
        authentication: "none",
        mode: "read-only",
        contentType: "application/json",
      },
      endpoints: {
        network: {
          url: `${origin}/api/network`,
          description:
            "Direct-source exact rolling 24h, 7d, and 30d aggregates and time-series buckets. All-time backfill is in progress.",
        },
        services: {
          url: `${origin}/api/services`,
          description:
            "Paginated service-origin records with protocol, period, and ranking controls.",
          query: {
            protocol: ["all", "mpp", "x402"],
            days: [0, 1, 7, 30],
            sort: ["transactions", "volume", "buyers"],
            page: "integer >= 1",
            pageSize: "integer 10–50",
          },
        },
        ask: {
          url: `${origin}/api/ask`,
          method: "POST",
          description:
            "Deterministic analysis with explicit evidence gates for identity-level questions.",
        },
        cohorts: {
          url: `${origin}/api/cohorts`,
          description:
            "Buyer and service identity retention from verified identity-level evidence, with activity/acquisition definitions and coverage limits.",
          query: {
            protocol: ["all", "mpp", "x402"],
            role: ["payer", "payee"],
            mode: ["activity", "acquisition"],
            cohortMonth: "YYYY-MM (optional)",
            months: "integer 1–24",
          },
        },
        wallets: {
          url: `${origin}/api/wallets`,
          description:
            "Open wallet-attribution registry, evidence rules, and current attribution coverage.",
        },
        submissions: {
          url: `${origin}/api/submissions`,
          method: "POST",
          description:
            "Service submission and domain-control verification challenge flow.",
        },
      },
      metricStates: {
        raw: "Directly observed activity under protocol-specific attribution rules.",
        resolved:
          "Recipient activity associated with a public service-origin record.",
        adjusted:
          "Not yet applied. Current data may include tests, internal activity, and unresolved counterparties.",
      },
      identityLayer: {
        privacy: "Raw payer and payee identities are hashed before storage and are never returned by the public cohort API.",
        acceptedEvidence: [
          "verified MPP Credential + Receipt history",
          "successful x402 settlement responses with confirmed payment references",
          "deterministically attributable confirmed-chain settlements",
        ],
        excludedEvidence: [
          "rolling aggregate unique counts",
          "ordinary stablecoin transfers without protocol attribution",
          "declared or inferred identities in verified retention results",
        ],
      },
      provenance: [
        {
          protocol: "mpp",
          source: "Tempo direct chain evidence",
          url: "https://docs.tempo.xyz/guide/payments/transfer-memos",
        },
        {
          protocol: "x402",
          source: "Base USDC direct chain evidence plus versioned facilitator registry",
          url: "https://docs.cdp.coinbase.com/data/sql-api/welcome",
        },
      ],
      citation:
        "The Agentic Payments Index, including the source and as-of timestamp returned with the requested data.",
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=3600",
      },
    },
  );
}
