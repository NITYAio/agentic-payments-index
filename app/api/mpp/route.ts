type UpstreamStats = {
  totalTransactions: number;
  totalVolume: number;
  uniqueSenders: number;
  uniqueRecipients: number;
};

type UpstreamBucket = {
  bucket_start: string;
  total_transactions: number;
  total_volume: number;
  unique_senders: number;
  unique_recipients: number;
};

type Service = {
  id: string;
  name: string;
  description: string;
  url: string;
  rank: number;
  stats: {
    transactions: number;
    volume: number;
    buyers: number;
    latestTx: string;
  };
};

const UPSTREAM = "https://mppscan.com/api/trpc";

function trpcInput(input: Record<string, unknown>) {
  return encodeURIComponent(JSON.stringify({ "0": { json: input } }));
}

async function getPeriod(days: 1 | 7 | 30) {
  const input = encodeURIComponent(
    JSON.stringify({
      "0": { json: { timeframeDays: days } },
      "1": { json: { timeframeDays: days } },
    }),
  );
  const response = await fetch(
    `${UPSTREAM}/stats.protocolStats,stats.bucketed?batch=1&input=${input}`,
    {
      headers: {
        accept: "application/json",
        "x-trpc-source": "blockscope",
      },
    },
  );
  if (!response.ok) throw new Error(`MPP stats returned ${response.status}`);
  const payload = (await response.json()) as [
    { result: { data: { json: UpstreamStats } } },
    { result: { data: { json: UpstreamBucket[] } } },
  ];
  return {
    stats: payload[0].result.data.json,
    buckets: payload[1].result.data.json,
  };
}

async function getServices(days: 1 | 7 | 30) {
  const input = {
    timeframeDays: days,
    sorting: { id: "tx_count", desc: true },
    page: 0,
    pageSize: 12,
  };
  const response = await fetch(
    `${UPSTREAM}/servers.list?batch=1&input=${trpcInput(input)}`,
    {
      headers: {
        accept: "application/json",
        "x-trpc-source": "blockscope",
      },
    },
  );
  if (!response.ok) throw new Error(`MPP services returned ${response.status}`);
  const payload = (await response.json()) as [
    { result: { data: { json: { origins: Service[] } } } },
  ];
  return payload[0].result.data.json.origins;
}

function buckets(days: number): UpstreamBucket[] {
  const count = days === 1 ? 48 : days === 7 ? 56 : 60;
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const wave =
      0.72 +
      Math.sin(index * 0.71) * 0.12 +
      Math.cos(index * 0.27) * 0.09;
    const transactions = Math.round((days === 1 ? 540 : 2500) * wave);
    return {
      bucket_start: new Date(
        now - (count - index) * (days * 86400000) / count,
      ).toISOString(),
      total_transactions: transactions,
      total_volume: transactions * (0.075 + (index % 7) * 0.004),
      unique_senders: Math.round(transactions * 0.73),
      unique_recipients: 18 + (index % 13),
    };
  });
}

function fallback() {
  return {
    source: "Preview dataset",
    live: false,
    asOf: new Date().toISOString(),
    periods: {
      "1": {
        stats: {
          totalTransactions: 26170,
          totalVolume: 2470.91,
          uniqueSenders: 5509,
          uniqueRecipients: 125,
        },
        buckets: buckets(1),
      },
      "7": {
        stats: {
          totalTransactions: 149420,
          totalVolume: 12782.4,
          uniqueSenders: 17410,
          uniqueRecipients: 182,
        },
        buckets: buckets(7),
      },
      "30": {
        stats: {
          totalTransactions: 573806,
          totalVolume: 46704.55,
          uniqueSenders: 39102,
          uniqueRecipients: 246,
        },
        buckets: buckets(30),
      },
    },
    services: { "1": [], "7": [], "30": [] },
  };
}

export async function GET() {
  try {
    const [day, week, month, dayServices, weekServices, monthServices] =
      await Promise.all([
        getPeriod(1),
        getPeriod(7),
        getPeriod(30),
        getServices(1),
        getServices(7),
        getServices(30),
      ]);

    return Response.json(
      {
        source: "MPPScan public analytics",
        live: true,
        asOf: new Date().toISOString(),
        periods: { "1": day, "7": week, "30": month },
        services: {
          "1": dayServices,
          "7": weekServices,
          "30": monthServices,
        },
      },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=120",
        },
      },
    );
  } catch {
    return Response.json(fallback(), {
      headers: {
        "Cache-Control": "public, max-age=30",
      },
    });
  }
}
