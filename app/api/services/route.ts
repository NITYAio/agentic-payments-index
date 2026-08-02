type ProtocolKey = "all" | "mpp" | "x402";
type SortKey = "transactions" | "volume" | "buyers";

type Service = {
  id: string;
  name: string;
  description: string;
  url: string;
  rank: number;
  protocol: "mpp" | "x402";
  network: string;
  stats: {
    transactions: number;
    volume: number;
    buyers: number;
    latestTx: string;
  };
};

type MppOrigin = Omit<Service, "protocol" | "network">;

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

type MppPage = {
  items: Service[];
  total: number;
  hasNextPage: boolean;
};

type X402Page = {
  items: Service[];
  total: number;
  totalPages: number;
  hasNextPage: boolean;
};

const MPP_UPSTREAM = "https://mppscan.com/api/trpc";
const X402_UPSTREAM = "https://www.x402scan.com/api/trpc";
const UPSTREAM_PAGE_SIZE = 100;

const SORT_FIELDS: Record<SortKey, string> = {
  transactions: "tx_count",
  volume: "total_amount",
  buyers: "unique_buyers",
};

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

function normalizeMpp(origin: MppOrigin): Service {
  return {
    ...origin,
    protocol: "mpp",
    network: "Tempo",
  };
}

function normalizeX402(seller: X402Seller, index: number): Service {
  const origin = seller.origins[0];
  const recipient = seller.recipients[0] ?? `seller-${index}`;
  return {
    id: origin?.id ?? recipient,
    name: cleanTitle(origin?.title ?? null, origin?.origin ?? recipient),
    description:
      origin?.description ??
      `${seller.chains.join(", ")} seller via ${seller.facilitators.join(", ")}`,
    url:
      origin?.origin ??
      `https://www.x402scan.com/recipient/${encodeURIComponent(recipient)}`,
    rank: index + 1,
    protocol: "x402",
    network: seller.chains.join(" + ") || "Onchain",
    stats: {
      transactions: seller.tx_count,
      volume: seller.total_amount / 1_000_000,
      buyers: seller.unique_buyers,
      latestTx: seller.latest_block_timestamp ?? new Date(0).toISOString(),
    },
  };
}

async function fetchMppPage(
  days: 0 | 1 | 7 | 30,
  sort: SortKey,
  page: number,
  pageSize: number,
): Promise<MppPage> {
  const response = await fetch(
    `${MPP_UPSTREAM}/servers.list?batch=1&input=${encodeURIComponent(
      JSON.stringify({
        "0": {
          json: {
            timeframeDays: days,
            sorting: { id: SORT_FIELDS[sort], desc: true },
            page,
            pageSize,
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
  if (!response.ok) throw new Error(`MPP directory returned ${response.status}`);
  const payload = (await response.json()) as Array<{
    result?: {
      data: { json: { origins: MppOrigin[]; total: number } };
    };
    error?: unknown;
  }>;
  const data = payload[0]?.result?.data.json;
  if (!data) throw new Error("MPP directory returned an invalid payload");
  return {
    items: data.origins.map(normalizeMpp),
    total: data.total,
    hasNextPage: (page + 1) * pageSize < data.total,
  };
}

async function fetchX402Page(
  days: 0 | 1 | 7 | 30,
  sort: SortKey,
  page: number,
  pageSize: number,
): Promise<X402Page> {
  const input = encodeURIComponent(
    JSON.stringify({
      json: {
        timeframe: days,
        sorting: { id: SORT_FIELDS[sort], desc: true },
        pagination: { page, page_size: pageSize },
      },
    }),
  );
  const response = await fetch(
    `${X402_UPSTREAM}/public.sellers.bazaar.list?input=${input}`,
    {
      headers: {
        accept: "application/json",
        "x-trpc-source": "agentic-payments-index",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`x402 directory returned ${response.status}`);
  }
  const payload = (await response.json()) as {
    result?: {
      data: {
        json: {
          items: X402Seller[];
          total_count: number;
          total_pages: number;
          hasNextPage: boolean;
        };
      };
    };
  };
  const data = payload.result?.data.json;
  if (!data) throw new Error("x402 directory returned an invalid payload");
  return {
    items: data.items.map(normalizeX402),
    total: data.total_count,
    totalPages: data.total_pages,
    hasNextPage: data.hasNextPage,
  };
}

async function loadMppPrefix(
  days: 0 | 1 | 7 | 30,
  sort: SortKey,
  needed: number,
) {
  const first = await fetchMppPage(
    days,
    sort,
    0,
    Math.min(UPSTREAM_PAGE_SIZE, Math.max(needed, 1)),
  );
  if (first.items.length >= needed || !first.hasNextPage) return first;

  const pageCount = Math.min(
    Math.ceil(first.total / UPSTREAM_PAGE_SIZE),
    Math.ceil(needed / UPSTREAM_PAGE_SIZE),
  );
  const remaining = await Promise.all(
    Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
      fetchMppPage(days, sort, index + 1, UPSTREAM_PAGE_SIZE),
    ),
  );
  return {
    ...first,
    items: [first, ...remaining].flatMap((page) => page.items),
  };
}

async function loadAllX402Origins(
  days: 0 | 1 | 7 | 30,
  sort: SortKey,
) {
  const first = await fetchX402Page(
    days,
    sort,
    0,
    UPSTREAM_PAGE_SIZE,
  );
  const remaining = await Promise.all(
    Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, index) =>
      fetchX402Page(
        days,
        sort,
        index + 1,
        UPSTREAM_PAGE_SIZE,
      ),
    ),
  );
  const pages = [first, ...remaining];
  const origins = new Map<string, Service>();

  for (const item of pages.flatMap((page) => page.items)) {
    const existing = origins.get(item.id);
    if (!existing) {
      origins.set(item.id, item);
      continue;
    }
    existing.stats.transactions += item.stats.transactions;
    existing.stats.volume += item.stats.volume;
    existing.stats.buyers += item.stats.buyers;
    if (
      new Date(item.stats.latestTx).getTime() >
      new Date(existing.stats.latestTx).getTime()
    ) {
      existing.stats.latestTx = item.stats.latestTx;
    }
    const networks = new Set(
      `${existing.network} + ${item.network}`
        .split(" + ")
        .map((network) => network.trim())
        .filter(Boolean),
    );
    existing.network = [...networks].join(" + ");
  }

  const items = [...origins.values()].sort(
    (left, right) =>
      metricForSort(right, sort) - metricForSort(left, sort),
  );
  return {
    items,
    total: items.length,
    rawRecipientRecords: first.total,
  };
}

function metricForSort(service: Service, sort: SortKey) {
  return service.stats[sort];
}

function parseProtocol(value: string | null): ProtocolKey {
  return value === "mpp" || value === "x402" ? value : "all";
}

function parseSort(value: string | null): SortKey {
  return value === "volume" || value === "buyers" ? value : "transactions";
}

function parseDays(value: string | null): 0 | 1 | 7 | 30 {
  if (value === "0" || value === "1" || value === "7") {
    return Number(value) as 0 | 1 | 7;
  }
  return 30;
}

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function compactInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const protocol = parseProtocol(url.searchParams.get("protocol"));
  const sort = parseSort(url.searchParams.get("sort"));
  const days = parseDays(url.searchParams.get("days"));
  const page = boundedInteger(url.searchParams.get("page"), 1, 1, 500);
  const pageSize = boundedInteger(
    url.searchParams.get("pageSize"),
    20,
    10,
    50,
  );
  const offset = (page - 1) * pageSize;

  try {
    if (protocol === "mpp") {
      const result = await fetchMppPage(
        days,
        sort,
        page - 1,
        pageSize,
      );
      return Response.json(
        {
          items: result.items.map((item, index) => ({
            ...item,
            rank: offset + index + 1,
          })),
          total: result.total,
          totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
          page,
          pageSize,
          sourceTotals: { mpp: result.total, x402: 0 },
          disclosure:
            `${days === 0 ? "All available" : "All"} resolved MPP service origins returned by the public MPPScan directory for this window.`,
          asOf: new Date().toISOString(),
        },
        {
          headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
        },
      );
    }

    if (protocol === "x402") {
      const result = await loadAllX402Origins(days, sort);
      const items = result.items.slice(offset, offset + pageSize);
      return Response.json(
        {
          items: items.map((item, index) => ({
            ...item,
            rank: offset + index + 1,
          })),
          total: result.total,
          totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
          page,
          pageSize,
          sourceTotals: { mpp: 0, x402: result.total },
          disclosure:
            `All resolved x402 service origins returned across the public Bazaar pages for this window, regrouped across ${compactInteger(result.rawRecipientRecords)} underlying recipient records.`,
          asOf: new Date().toISOString(),
        },
        {
          headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
        },
      );
    }

    const needed = page * pageSize;
    const [mpp, x402] = await Promise.all([
      loadMppPrefix(days, sort, needed),
      loadAllX402Origins(days, sort),
    ]);
    const combined = [...mpp.items, ...x402.items].sort(
      (left, right) =>
        metricForSort(right, sort) - metricForSort(left, sort),
    );
    const total = mpp.total + x402.total;
    const items = combined.slice(offset, offset + pageSize);

    return Response.json(
      {
        items: items.map((item, index) => ({
          ...item,
          rank: offset + index + 1,
        })),
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        page,
        pageSize,
        sourceTotals: { mpp: mpp.total, x402: x402.total },
        disclosure:
          "Combined resolved service-origin records. x402 origins are regrouped across every Bazaar page; a service indexed on both protocols may still appear twice and counts are not presented as unique companies.",
        asOf: new Date().toISOString(),
      },
      {
        headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The service directory is temporarily unavailable.",
      },
      { status: 502 },
    );
  }
}
