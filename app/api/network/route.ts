type PeriodKey = "1" | "7" | "30";
type ProtocolKey = "mpp" | "x402";

type Stats = {
  totalTransactions: number;
  totalVolume: number;
  uniqueSenders: number;
  uniqueRecipients: number;
};

type Bucket = {
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
  protocol: ProtocolKey;
  network: string;
  stats: {
    transactions: number;
    volume: number;
    buyers: number;
    latestTx: string;
  };
};

type ProtocolData = {
  source: string;
  live: boolean;
  disclosure: string;
  periods: Record<PeriodKey, { stats: Stats; buckets: Bucket[] }>;
  services: Record<PeriodKey, Service[]>;
};

type MppBucket = {
  bucket_start: string;
  total_transactions: number;
  total_volume: number;
  unique_senders: number;
  unique_recipients: number;
};

type MppService = Omit<Service, "protocol" | "network">;

type X402Stats = {
  total_transactions: number;
  total_amount: number;
  unique_buyers: number;
  unique_sellers: number;
  latest_block_timestamp: string | null;
};

type X402Bucket = {
  bucket_start: string;
  total_transactions: number;
  total_amount: number;
  unique_buyers: number;
  unique_sellers: number;
};

type X402Seller = {
  recipients: string[];
  origins: Array<{
    id: string;
    origin: string;
    title: string | null;
    description: string | null;
  }>;
  facilitators: string[];
  tx_count: number;
  total_amount: number;
  latest_block_timestamp: string | null;
  unique_buyers: number;
  chains: string[];
};

const MPP_UPSTREAM = "https://mppscan.com/api/trpc";
const X402_UPSTREAM = "https://www.x402scan.com/api/trpc";
const PERIOD_KEYS: PeriodKey[] = ["1", "7", "30"];

function emptyStats(): Stats {
  return {
    totalTransactions: 0,
    totalVolume: 0,
    uniqueSenders: 0,
    uniqueRecipients: 0,
  };
}

function emptyProtocol(source: string, disclosure: string): ProtocolData {
  return {
    source,
    live: false,
    disclosure,
    periods: {
      "1": { stats: emptyStats(), buckets: [] },
      "7": { stats: emptyStats(), buckets: [] },
      "30": { stats: emptyStats(), buckets: [] },
    },
    services: { "1": [], "7": [], "30": [] },
  };
}

function trpcInput(input: Record<string, unknown>) {
  return encodeURIComponent(JSON.stringify({ json: input }));
}

function trpcBatchInput(inputs: Array<Record<string, unknown>>) {
  return encodeURIComponent(
    JSON.stringify(
      Object.fromEntries(inputs.map((input, index) => [index, { json: input }])),
    ),
  );
}

async function getMppPeriod(days: 1 | 7 | 30) {
  const input = encodeURIComponent(
    JSON.stringify({
      "0": { json: { timeframeDays: days } },
      "1": { json: { timeframeDays: days } },
    }),
  );
  const response = await fetch(
    `${MPP_UPSTREAM}/stats.protocolStats,stats.bucketed?batch=1&input=${input}`,
    {
      headers: {
        accept: "application/json",
        "x-trpc-source": "agentic-payments-index",
      },
    },
  );
  if (!response.ok) throw new Error(`MPP stats returned ${response.status}`);
  const payload = (await response.json()) as [
    { result: { data: { json: Stats } } },
    { result: { data: { json: MppBucket[] } } },
  ];
  return {
    stats: payload[0].result.data.json,
    buckets: payload[1].result.data.json,
  };
}

async function getMppServices(days: 1 | 7 | 30) {
  const response = await fetch(
    `${MPP_UPSTREAM}/servers.list?batch=1&input=${encodeURIComponent(
      JSON.stringify({
        "0": {
          json: {
            timeframeDays: days,
            sorting: { id: "tx_count", desc: true },
            page: 0,
            pageSize: 12,
          },
        },
      }),
    )}`,
    {
      headers: {
        accept: "application/json",
        "x-trpc-source": "agentic-payments-index",
      },
    },
  );
  if (!response.ok) throw new Error(`MPP services returned ${response.status}`);
  const payload = (await response.json()) as [
    { result: { data: { json: { origins: MppService[] } } } },
  ];
  return payload[0].result.data.json.origins.map((service) => ({
    ...service,
    protocol: "mpp" as const,
    network: "Tempo",
  }));
}

async function loadMpp(): Promise<ProtocolData> {
  const [day, week, month, dayServices, weekServices, monthServices] =
    await Promise.all([
      getMppPeriod(1),
      getMppPeriod(7),
      getMppPeriod(30),
      getMppServices(1),
      getMppServices(7),
      getMppServices(30),
    ]);

  return {
    source: "MPPScan public analytics",
    live: true,
    disclosure: "Observed successful MPP payments indexed by MPPScan.",
    periods: { "1": day, "7": week, "30": month },
    services: {
      "1": dayServices,
      "7": weekServices,
      "30": monthServices,
    },
  };
}

async function getX402Period(days: 1 | 7 | 30) {
  const response = await fetch(
    `${X402_UPSTREAM}/public.stats.overall,public.stats.bucketed?batch=1&input=${trpcBatchInput(
      [
        { timeframe: days },
        { timeframe: days, numBuckets: 48 },
      ],
    )}`,
    {
      headers: {
        accept: "application/json",
        "x-trpc-source": "agentic-payments-index",
      },
    },
  );
  if (!response.ok) throw new Error(`x402 stats returned ${response.status}`);
  const payload = (await response.json()) as [
    { result: { data: { json: X402Stats } } },
    { result: { data: { json: X402Bucket[] } } },
  ];
  const stats = payload[0].result.data.json;
  return {
    stats: {
      totalTransactions: stats.total_transactions,
      totalVolume: stats.total_amount / 1_000_000,
      uniqueSenders: stats.unique_buyers,
      uniqueRecipients: stats.unique_sellers,
    },
    buckets: payload[1].result.data.json.map((bucket) => ({
      bucket_start: bucket.bucket_start,
      total_transactions: bucket.total_transactions,
      total_volume: bucket.total_amount / 1_000_000,
      unique_senders: bucket.unique_buyers,
      unique_recipients: bucket.unique_sellers,
    })),
  };
}

function cleanTitle(value: string | null, origin: string) {
  if (value) {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, "")
      .trim();
  }
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return origin;
  }
}

async function getX402Services(days: 1 | 7 | 30) {
  const response = await fetch(
    `${X402_UPSTREAM}/public.sellers.bazaar.list?input=${trpcInput({
      timeframe: days,
      sorting: { id: "tx_count", desc: true },
      pagination: { page: 0, page_size: 12 },
    })}`,
    {
      headers: {
        accept: "application/json",
        "x-trpc-source": "agentic-payments-index",
      },
    },
  );
  if (!response.ok) throw new Error(`x402 services returned ${response.status}`);
  const payload = (await response.json()) as {
    result: { data: { json: { items: X402Seller[] } } };
  };
  return payload.result.data.json.items.map((seller, index) => {
    const origin = seller.origins[0];
    const recipient = seller.recipients[0] ?? `seller-${index}`;
    return {
      id: origin?.id ?? recipient,
      name: cleanTitle(origin?.title ?? null, origin?.origin ?? recipient),
      description:
        origin?.description ??
        `${seller.chains.join(", ")} seller via ${seller.facilitators.join(", ")}`,
      url: origin?.origin ?? `https://www.x402scan.com/recipient/${recipient}`,
      rank: index + 1,
      protocol: "x402" as const,
      network: seller.chains.join(" + ") || "Onchain",
      stats: {
        transactions: seller.tx_count,
        volume: seller.total_amount / 1_000_000,
        buyers: seller.unique_buyers,
        latestTx: seller.latest_block_timestamp ?? new Date(0).toISOString(),
      },
    };
  });
}

async function loadX402(): Promise<ProtocolData> {
  const [day, week, month, dayServices, weekServices, monthServices] =
    await Promise.all([
      getX402Period(1),
      getX402Period(7),
      getX402Period(30),
      getX402Services(1),
      getX402Services(7),
      getX402Services(30),
    ]);

  return {
    source: "x402scan public analytics",
    live: true,
    disclosure:
      "Observed onchain x402 settlements indexed across supported facilitators.",
    periods: { "1": day, "7": week, "30": month },
    services: {
      "1": dayServices,
      "7": weekServices,
      "30": monthServices,
    },
  };
}

function mergeBuckets(days: number, sources: Bucket[][]): Bucket[] {
  const count = 48;
  const end = Date.now();
  const start = end - days * 86_400_000;
  const width = (end - start) / count;
  const output = Array.from({ length: count }, (_, index) => ({
    bucket_start: new Date(start + index * width).toISOString(),
    total_transactions: 0,
    total_volume: 0,
    unique_senders: 0,
    unique_recipients: 0,
  }));

  for (const source of sources) {
    for (const bucket of source) {
      const timestamp = new Date(bucket.bucket_start).getTime();
      const index = Math.min(
        count - 1,
        Math.max(0, Math.floor((timestamp - start) / width)),
      );
      const target = output[index];
      target.total_transactions += bucket.total_transactions;
      target.total_volume += bucket.total_volume;
      target.unique_senders += bucket.unique_senders;
      target.unique_recipients += bucket.unique_recipients;
    }
  }
  return output;
}

function combineProtocols(mpp: ProtocolData, x402: ProtocolData): ProtocolData {
  const periods = Object.fromEntries(
    PERIOD_KEYS.map((key) => {
      const left = mpp.periods[key];
      const right = x402.periods[key];
      return [
        key,
        {
          stats: {
            totalTransactions:
              left.stats.totalTransactions + right.stats.totalTransactions,
            totalVolume: left.stats.totalVolume + right.stats.totalVolume,
            uniqueSenders:
              left.stats.uniqueSenders + right.stats.uniqueSenders,
            uniqueRecipients:
              left.stats.uniqueRecipients + right.stats.uniqueRecipients,
          },
          buckets: mergeBuckets(Number(key), [left.buckets, right.buckets]),
        },
      ];
    }),
  ) as ProtocolData["periods"];

  const services = Object.fromEntries(
    PERIOD_KEYS.map((key) => [
      key,
      [...mpp.services[key], ...x402.services[key]]
        .sort((a, b) => b.stats.transactions - a.stats.transactions)
        .slice(0, 18),
    ]),
  ) as ProtocolData["services"];

  return {
    source: "MPPScan + x402scan public analytics",
    live: mpp.live || x402.live,
    disclosure:
      "Combined observed activity. Buyer and service counts are protocol-level sums and may contain overlap.",
    periods,
    services,
  };
}

export async function GET() {
  const [mppResult, x402Result] = await Promise.allSettled([
    loadMpp(),
    loadX402(),
  ]);

  const mpp =
    mppResult.status === "fulfilled"
      ? mppResult.value
      : emptyProtocol(
          "MPPScan unavailable",
          "MPP data is temporarily unavailable; no placeholder values are shown.",
        );
  const x402 =
    x402Result.status === "fulfilled"
      ? x402Result.value
      : emptyProtocol(
          "x402scan unavailable",
          "x402 data is temporarily unavailable; no placeholder values are shown.",
        );
  const all = combineProtocols(mpp, x402);

  return Response.json(
    {
      source: all.source,
      live: mpp.live || x402.live,
      asOf: new Date().toISOString(),
      protocols: { all, mpp, x402 },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=120",
      },
    },
  );
}
