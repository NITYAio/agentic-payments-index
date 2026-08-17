import { getD1 } from "../../../db";

type PeriodKey = "0" | "1" | "7" | "30";
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

type PeriodData = {
  stats: Stats;
  buckets: Bucket[];
  rangeStart: string | null;
  rangeEnd: string | null;
};

type ProtocolData = {
  source: string;
  live: boolean;
  disclosure: string;
  measurementLabel: string;
  volumeLabel: string;
  volumeComparable: boolean;
  periods: Record<PeriodKey, PeriodData>;
  services: Record<PeriodKey, Service[]>;
};

type WindowRow = {
  run_id: string;
  protocol: ProtocolKey;
  network: string;
  range_start: string;
  range_end: string;
  transaction_count: number;
  volume_usd_micros: number;
  buyer_count: number;
  seller_count: number;
};

type DailyRow = {
  run_id: string;
  activity_date: string;
  transaction_count: number;
  volume_usd_micros: number;
  buyer_count: number;
  seller_count: number;
};

type MppService = Omit<Service, "protocol" | "network">;

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
const PERIOD_KEYS: PeriodKey[] = ["0", "1", "7", "30"];
const DIRECT_PERIOD_KEYS: PeriodKey[] = ["0", "1", "7", "30"];

function emptyStats(): Stats {
  return {
    totalTransactions: 0,
    totalVolume: 0,
    uniqueSenders: 0,
    uniqueRecipients: 0,
  };
}

function emptyPeriod(): PeriodData {
  return { stats: emptyStats(), buckets: [], rangeStart: null, rangeEnd: null };
}

function emptyProtocol(
  source: string,
  disclosure: string,
  measurementLabel: string,
  volumeLabel: string,
  volumeComparable = true,
): ProtocolData {
  return {
    source,
    live: false,
    disclosure,
    measurementLabel,
    volumeLabel,
    volumeComparable,
    periods: {
      "0": emptyPeriod(),
      "1": emptyPeriod(),
      "7": emptyPeriod(),
      "30": emptyPeriod(),
    },
    services: { "0": [], "1": [], "7": [], "30": [] },
  };
}

function trpcInput(input: Record<string, unknown>) {
  return encodeURIComponent(JSON.stringify({ json: input }));
}

async function getMppServices(days: 0 | 1 | 7 | 30) {
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

async function getX402Services(days: 0 | 1 | 7 | 30) {
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

async function loadServiceDirectories() {
  const requests = PERIOD_KEYS.flatMap((key) => {
    const days = Number(key) as 0 | 1 | 7 | 30;
    return [getMppServices(days), getX402Services(days)];
  });
  const results = await Promise.allSettled(requests);
  const mpp = { "0": [], "1": [], "7": [], "30": [] } as Record<PeriodKey, Service[]>;
  const x402 = { "0": [], "1": [], "7": [], "30": [] } as Record<PeriodKey, Service[]>;
  PERIOD_KEYS.forEach((key, index) => {
    const left = results[index * 2];
    const right = results[index * 2 + 1];
    if (left.status === "fulfilled") mpp[key] = left.value;
    if (right.status === "fulfilled") x402[key] = right.value;
  });
  return { mpp, x402 };
}

function windowDurationDays(row: WindowRow) {
  return (
    (new Date(row.range_end).getTime() - new Date(row.range_start).getTime()) /
    86_400_000
  );
}

async function loadDirectProtocol(protocol: ProtocolKey): Promise<ProtocolData> {
  const base =
    protocol === "mpp"
      ? emptyProtocol(
          "Tempo direct chain evidence",
          "Current-version MPP charges and settled sessions observed directly on Tempo. Testing, internal activity, and repeated identities may still be included.",
          "Protocol-attributed payments",
          "Payment value",
        )
      : emptyProtocol(
          "Base direct chain evidence",
          "USDC payments involving the maintained x402 facilitator set on Base. Receive-and-forward chains count once at the payer's original amount and are attributed to the terminal recipient.",
          "Facilitator-associated payments",
          "Payment value",
        );
  const d1 = await getD1();
  const windowResult = await d1
    .prepare(
      `SELECT run_id, protocol, network, range_start, range_end,
              transaction_count, volume_usd_micros, buyer_count, seller_count
       FROM protocol_window_metrics
       WHERE protocol = ?
       ORDER BY range_end DESC`,
    )
    .bind(protocol)
    .all<WindowRow>();

  const selected = new Map<PeriodKey, WindowRow>();
  let widestWindow: WindowRow | null = null;
  for (const row of windowResult.results) {
    const days = Math.round(windowDurationDays(row));
    const key = String(days) as PeriodKey;
    if (key !== "0" && DIRECT_PERIOD_KEYS.includes(key) && !selected.has(key)) {
      selected.set(key, row);
    }
    if (
      !widestWindow ||
      windowDurationDays(row) > windowDurationDays(widestWindow) ||
      (windowDurationDays(row) === windowDurationDays(widestWindow) &&
        row.range_end > widestWindow.range_end)
    ) {
      widestWindow = row;
    }
  }
  if (widestWindow && windowDurationDays(widestWindow) > 30) {
    selected.set("0", widestWindow);
  }

  const runIds = [...selected.values()].map((row) => row.run_id);
  const dailyResult = runIds.length
    ? await d1
        .prepare(
          `SELECT run_id, activity_date, transaction_count, volume_usd_micros,
                  buyer_count, seller_count
           FROM daily_protocol_metrics
           WHERE run_id IN (${runIds.map(() => "?").join(", ")})
           ORDER BY activity_date ASC`,
        )
        .bind(...runIds)
        .all<DailyRow>()
    : { results: [] as DailyRow[] };

  for (const key of DIRECT_PERIOD_KEYS) {
    const row = selected.get(key);
    if (!row) continue;
    base.periods[key] = {
      stats: {
        totalTransactions: row.transaction_count,
        totalVolume: row.volume_usd_micros / 1_000_000,
        uniqueSenders: row.buyer_count,
        uniqueRecipients: row.seller_count,
      },
      buckets: dailyResult.results
        .filter((daily) => daily.run_id === row.run_id)
        .map((daily) => ({
          bucket_start: `${daily.activity_date}T00:00:00.000Z`,
          total_transactions: daily.transaction_count,
          total_volume: daily.volume_usd_micros / 1_000_000,
          unique_senders: daily.buyer_count,
          unique_recipients: daily.seller_count,
        })),
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
    };
  }
  base.live = selected.size > 0;
  return base;
}

function mergeBuckets(sources: Bucket[][]): Bucket[] {
  const merged = new Map<string, Bucket>();
  for (const source of sources) {
    for (const bucket of source) {
      const key = bucket.bucket_start;
      const current = merged.get(key) ?? {
        bucket_start: key,
        total_transactions: 0,
        total_volume: 0,
        unique_senders: 0,
        unique_recipients: 0,
      };
      current.total_transactions += bucket.total_transactions;
      current.unique_senders += bucket.unique_senders;
      current.unique_recipients += bucket.unique_recipients;
      current.total_volume = 0;
      merged.set(key, current);
    }
  }
  return [...merged.values()].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
}

function earliestTimestamp(...values: Array<string | null>) {
  return values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}

function latestTimestamp(...values: Array<string | null>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function combineProtocols(mpp: ProtocolData, x402: ProtocolData): ProtocolData {
  const periods = Object.fromEntries(
    PERIOD_KEYS.map((key) => {
      const left = mpp.periods[key];
      const right = x402.periods[key];
      if (
        key === "0" &&
        (!left.rangeStart || !left.rangeEnd || !right.rangeStart || !right.rangeEnd)
      ) {
        return [
          key,
          {
            stats: {
              totalTransactions: 0,
              totalVolume: 0,
              uniqueSenders: 0,
              uniqueRecipients: 0,
            },
            buckets: [],
            rangeStart: null,
            rangeEnd: null,
          },
        ];
      }
      return [
        key,
        {
          stats: {
            totalTransactions: left.stats.totalTransactions + right.stats.totalTransactions,
            totalVolume: 0,
            uniqueSenders: left.stats.uniqueSenders + right.stats.uniqueSenders,
            uniqueRecipients: left.stats.uniqueRecipients + right.stats.uniqueRecipients,
          },
          buckets: mergeBuckets([left.buckets, right.buckets]),
          rangeStart: earliestTimestamp(left.rangeStart, right.rangeStart),
          rangeEnd: latestTimestamp(left.rangeEnd, right.rangeEnd),
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
    source: "Independent Tempo + Base observations",
    live: mpp.live || x402.live,
    disclosure:
      "Transaction and identity counts are protocol-level sums and may overlap. MPP and x402 payment values are each directly reconstructed, but market totals remain separate because protocol and network coverage differ.",
    measurementLabel: "Observed MPP + x402 activity",
    volumeLabel: "Not combined",
    volumeComparable: false,
    periods,
    services,
  };
}

export async function GET() {
  const [mppResult, x402Result, directoryResult] = await Promise.allSettled([
    loadDirectProtocol("mpp"),
    loadDirectProtocol("x402"),
    loadServiceDirectories(),
  ]);
  const mpp =
    mppResult.status === "fulfilled"
      ? mppResult.value
      : emptyProtocol(
          "Tempo direct evidence unavailable",
          "MPP direct-source data is temporarily unavailable; no placeholder values are shown.",
          "Protocol-attributed payments",
          "Payment value",
        );
  const x402 =
    x402Result.status === "fulfilled"
      ? x402Result.value
      : emptyProtocol(
          "Base direct evidence unavailable",
          "x402 direct-source data is temporarily unavailable; no placeholder values are shown.",
          "Facilitator-associated payments",
          "Payment value",
        );
  if (directoryResult.status === "fulfilled") {
    mpp.services = directoryResult.value.mpp;
    x402.services = directoryResult.value.x402;
  }
  const all = combineProtocols(mpp, x402);
  const rangeEnds = [
    mpp.periods["0"].rangeEnd ?? mpp.periods["30"].rangeEnd,
    x402.periods["0"].rangeEnd ?? x402.periods["30"].rangeEnd,
  ]
    .filter((value): value is string => Boolean(value))
    .sort();
  return Response.json(
    {
      source: all.source,
      live: mpp.live || x402.live,
      asOf: rangeEnds.at(-1) ?? "",
      protocols: { all, mpp, x402 },
    },
    {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=120" },
    },
  );
}
