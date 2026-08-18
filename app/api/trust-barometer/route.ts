type ProtocolKey = "all" | "mpp" | "x402";

function parseProtocol(value: string | null): ProtocolKey {
  return value === "mpp" || value === "x402" ? value : "all";
}

function parseDays(value: string | null): 0 | 7 | 30 | 90 {
  if (value === "0" || value === "7" || value === "90") return Number(value) as 0 | 7 | 90;
  return 30;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const protocol = parseProtocol(url.searchParams.get("protocol"));
  const days = parseDays(url.searchParams.get("days"));

  return Response.json(
    {
      available: false,
      status: "unavailable",
      protocol,
      days,
      coverageStart: null,
      coverageEnd: null,
      reason:
        "Agent-commerce classification is being validated. No threshold is published until free calls, token mints, self-transfers, and speculative flows can be removed reproducibly.",
      methodology: "/coverage#trust-barometer-method",
      metrics: null,
    },
    {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
    },
  );
}
