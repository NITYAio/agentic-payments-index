export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      name: "The Agentic Payments Index",
      slug: "the-agentic-payments-index",
      description:
        "An open evidence layer for machine-native stablecoin payments across MPP and x402.",
      schemaVersion: "0.3.0",
      access: {
        authentication: "none",
        mode: "read-only",
        contentType: "application/json",
      },
      endpoints: {
        network: {
          url: `${origin}/api/network`,
          description:
            "Protocol-level 24h, 7d, 30d, and available-history aggregates and time-series buckets.",
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
        raw: "Observed protocol-indexed activity.",
        resolved:
          "Recipient activity associated with a public service-origin record.",
        adjusted:
          "Not yet applied. Current data may include tests, internal activity, and unresolved counterparties.",
      },
      provenance: [
        {
          protocol: "mpp",
          source: "MPPScan public analytics",
          url: "https://mppscan.com",
        },
        {
          protocol: "x402",
          source: "x402scan public analytics",
          url: "https://www.x402scan.com",
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
