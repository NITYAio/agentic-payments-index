import { GET as getNetworkSnapshot } from "../network/route";
import {
  asksForChange,
  classifyQuery,
  protocolForQuery,
  windowForQuery,
} from "../../../lib/query-intent";
import {
  parseCohortRequest,
  type CohortMatrix,
} from "../../../lib/cohort-analysis";
import { loadCohortMatrix } from "../../../lib/cohort-store";
import {
  checkPublicRateLimit,
  rateLimitHeaders,
} from "../../../lib/rate-limit";

type ProtocolKey = "all" | "mpp" | "x402";
type WindowDays = 0 | 1 | 7 | 30;
type PeriodKey = "0" | "1" | "7" | "30";

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
  name: string;
  stats: { transactions: number; volume: number; buyers: number };
};

type ExplorerData = {
  asOf: string;
  protocols: Record<
    ProtocolKey,
    {
      source: string;
      periods: Record<
        PeriodKey,
        { stats: Stats; buckets: Bucket[] }
      >;
      services: Record<PeriodKey, Service[]>;
    }
  >;
};

type AnswerMetric = "average" | "volume" | "transactions" | "buyers" | "servers";

type Answer = {
  eyebrow: string;
  value: string;
  change: number | null;
  comparison: string;
  formula: string;
  explanation: string;
  days: WindowDays;
  metric: AnswerMetric;
  protocol: ProtocolKey;
  limited?: boolean;
  status?: string;
  visualization?: "series" | "cohort" | "none";
  chartProtocols?: ProtocolKey[];
  cohort?: CohortMatrix;
  source: string;
  asOf: string;
};

const PERIOD_KEYS: Record<WindowDays, PeriodKey> = {
  0: "0",
  1: "1",
  7: "7",
  30: "30",
};

const PROTOCOL_LABELS: Record<ProtocolKey, string> = {
  all: "MPP + x402",
  mpp: "MPP",
  x402: "x402",
};

function compact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value > 9999 ? 1 : 2,
  }).format(value);
}

function usd(value: number, precise = false) {
  const digits = precise && value < 1 ? (value < 0.01 ? 5 : 4) : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
}

function percent(value: number) {
  if (!Number.isFinite(value)) return "not enough data";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function percentageDelta(value: number, baseline: number) {
  if (!baseline) return null;
  return ((value - baseline) / baseline) * 100;
}

function windowLabel(days: WindowDays) {
  if (days === 0) return "available indexed history";
  if (days === 1) return "past 24 hours";
  return `past ${days} days`;
}

function coverageDays(buckets: Bucket[], fallback: number) {
  if (fallback) return fallback;
  const times = buckets
    .map((bucket) => new Date(bucket.bucket_start).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (times.length < 2) return 1;
  return Math.max(1, (times.at(-1)! - times[0]) / 86_400_000 + 1);
}

function metricValue(stats: Stats, metric: AnswerMetric) {
  if (metric === "volume") return stats.totalVolume;
  if (metric === "buyers") return stats.uniqueSenders;
  if (metric === "servers") return stats.uniqueRecipients;
  if (metric === "average") {
    return stats.totalTransactions ? stats.totalVolume / stats.totalTransactions : 0;
  }
  return stats.totalTransactions;
}

function bucketMetric(bucket: Bucket, metric: AnswerMetric) {
  if (metric === "volume") return bucket.total_volume;
  if (metric === "buyers") return bucket.unique_senders;
  if (metric === "servers") return bucket.unique_recipients;
  if (metric === "average") {
    return bucket.total_transactions ? bucket.total_volume / bucket.total_transactions : 0;
  }
  return bucket.total_transactions;
}

function metricForText(text: string): AnswerMetric {
  if (/\b(avg|average|mean|payment size|transaction size)\b/i.test(text)) return "average";
  if (/\b(volume|usd|dollars?|spend|value)\b/i.test(text)) return "volume";
  if (/\b(payers?|buyers?|senders?|agents?)\b/i.test(text)) return "buyers";
  if (/\b(servers?|recipients?)\b/i.test(text)) return "servers";
  return "transactions";
}

function trendForBuckets(buckets: Bucket[], metric: AnswerMetric) {
  const ordered = [...buckets].sort((left, right) =>
    left.bucket_start.localeCompare(right.bucket_start),
  );
  if (ordered.length < 4) return null;
  const segment = Math.max(2, Math.floor(ordered.length / 3));
  const first = ordered.slice(0, segment).map((bucket) => bucketMetric(bucket, metric));
  const last = ordered.slice(-segment).map((bucket) => bucketMetric(bucket, metric));
  const firstAverage = first.reduce((sum, value) => sum + value, 0) / first.length;
  const lastAverage = last.reduce((sum, value) => sum + value, 0) / last.length;
  return percentageDelta(lastAverage, firstAverage);
}

function findDatedBucket(question: string, buckets: Bucket[]) {
  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const match = question.toLowerCase().match(
    new RegExp(`\\b(${monthNames.join("|")}|${monthNames.map((month) => month.slice(0, 3)).join("|")})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`),
  );
  const ordered = [...buckets].sort((left, right) =>
    left.bucket_start.localeCompare(right.bucket_start),
  );
  if (!match) {
    return ordered.reduce<Bucket | null>(
      (largest, bucket) =>
        !largest || bucket.total_transactions > largest.total_transactions
          ? bucket
          : largest,
      null,
    );
  }
  const rawMonth = match[1];
  const month = monthNames.findIndex(
    (name) => name === rawMonth || name.startsWith(rawMonth),
  );
  const day = Number(match[2]);
  const year = match[3] ? Number(match[3]) : null;
  return (
    [...ordered].reverse().find((bucket) => {
      const date = new Date(bucket.bucket_start);
      return (
        date.getUTCMonth() === month &&
        date.getUTCDate() === day &&
        (year === null || date.getUTCFullYear() === year)
      );
    }) ?? null
  );
}

async function answerQuestion(
  data: ExplorerData,
  question: string,
  selectedProtocol: ProtocolKey,
  selectedWindow: WindowDays,
): Answer {
  const text = question.trim().toLowerCase();
  const protocol = protocolForQuery(text, selectedProtocol);
  const days = windowForQuery(text, selectedWindow);
  const intent = classifyQuery(text);
  const key = PERIOD_KEYS[days];
  const protocolData = data.protocols[protocol];
  const period = protocolData.periods[key];
  const current = period.stats;
  const label = PROTOCOL_LABELS[protocol];
  const range = windowLabel(days);
  const source = protocolData.source;
  const common = { days, protocol, source, asOf: data.asOf };

  if (intent === "cohort") {
    const request = parseCohortRequest(text, protocol);
    let cohort: CohortMatrix | null = null;
    try {
      cohort = await loadCohortMatrix(request);
    } catch {
      cohort = null;
    }
    const seller = request.role === "payee";
    if (cohort?.available) {
      const requestedRow = request.cohortMonth
        ? cohort.rows.find((row) => row.cohortMonth === request.cohortMonth)
        : null;
      const displayRow =
        requestedRow ??
        [...cohort.rows]
          .reverse()
          .find((row) => row.cohortSize > 0 && row.cells.length > 1) ??
        cohort.rows.find((row) => row.cohortSize > 0);
      const latestCell = displayRow?.cells.at(-1);
      const monthLabel = displayRow
        ? new Date(`${displayRow.cohortMonth}-01T00:00:00Z`).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })
        : "selected";
      const comparisonMonth = latestCell
        ? new Date(`${latestCell.calendarMonth}-01T00:00:00Z`).toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })
        : cohort.completeThrough;
      return {
        ...common,
        eyebrow: `${seller ? "Service" : "Payer"} ${request.mode} cohort · ${monthLabel}`,
        value:
          request.cohortMonth && latestCell
            ? `${latestCell.rate.toFixed(1)}% retained`
            : `${cohort.rows.filter((row) => row.cohortSize > 0).length} cohorts measured`,
        change: null,
        comparison:
          displayRow && latestCell
            ? `${latestCell.retained} of ${displayRow.cohortSize} identities returned in ${comparisonMonth} (M+${latestCell.offset})`
            : `Verified identity history is complete through ${cohort.completeThrough}.`,
        formula:
          request.mode === "activity"
            ? "Identities active again in month M+n ÷ identities active in cohort month M"
            : "First-active identities active again in month M+n ÷ first-active identities in month M",
        explanation: `${cohort.definition} ${cohort.limitation}`,
        metric: seller ? "servers" : "buyers",
        limited: Boolean(displayRow?.leftCensored),
        status: displayRow?.leftCensored
          ? "Verified; acquisition cohort is left-censored"
          : "Verified identity calculation",
        visualization: "cohort",
        cohort,
        source: `Agentic Payments Index identity layer${cohort.sources.length ? ` (${cohort.sources.join(", ")})` : ""}`,
      };
    }
    return {
      ...common,
      eyebrow: `${seller ? "Service" : "Payer"} cohort retention · collector status`,
      value: "Awaiting identity backfill",
      change: null,
      comparison: "The cohort engine is live, but no complete verified identity segment covers this request yet.",
      formula: seller
        ? "Verified service identity × cohort month × returning-active month"
        : "Hashed protocol identity × cohort month × returning-active month",
      explanation:
        `The storage, privacy-preserving identity normalization, idempotent ingestion, and cohort calculation layers are ready. A defensible ${seller ? "seller/service" : "buyer"} cohort will appear only after verified MPP receipt or x402 settlement history has been backfilled; rolling aggregate counts remain excluded.`,
      metric: seller ? "servers" : "buyers",
      limited: true,
      status: "Backfill required",
      visualization: "none",
    };
  }

  if (intent === "wallet") {
    return {
      ...common,
      eyebrow: "Wallet-provider attribution · evidence gate",
      value: "Coverage not yet measurable",
      change: null,
      comparison: "Provider signatures are not included in the current aggregate feeds.",
      formula: "Attributed payments ÷ all observed payments; confidence reported per rule",
      explanation:
        "The open attribution registry distinguishes wallet provider, account type, and facilitator, with Verified, Deterministic, Declared, Inferred, or Unknown confidence. Until independently indexed transaction evidence can be matched to those rules, provider shares remain unavailable rather than guessed.",
      metric: "transactions",
      limited: true,
      status: "Attribution evidence required",
      visualization: "none",
    };
  }

  if (intent === "autonomy") {
    return {
      ...common,
      eyebrow: "Autonomous execution · evidence gate",
      value: "Unknown",
      change: null,
      comparison: "Protocol settlement does not identify who or what authorized a payment.",
      formula: "Verified autonomous + agent-linked + likely automated + human-confirmed + unknown",
      explanation:
        "MPP and x402 can be used by people, applications, or agents. Autonomy requires signed execution attestations or other explicit evidence; it cannot be inferred from an onchain payment alone.",
      metric: "transactions",
      limited: true,
      status: "Autonomy evidence required",
      visualization: "none",
    };
  }

  if (intent === "anomaly") {
    const bucket = findDatedBucket(text, period.buckets);
    if (!bucket) {
      return {
        ...common,
        eyebrow: `Anomaly analysis · ${range}`,
        value: "No matching bucket",
        change: null,
        comparison: "No observed time bucket matches the requested date.",
        formula: "Requested bucket compared with the median observed bucket",
        explanation:
          "Try a date inside the selected indexed window. A cause will only be stated when contributor or external evidence supports it.",
        metric: "transactions",
        limited: true,
        status: "Date outside coverage",
        visualization: "none",
      };
    }
    const values = period.buckets
      .map((item) => item.total_transactions)
      .sort((left, right) => left - right);
    const median = values.length
      ? values[Math.floor(values.length / 2)]
      : 0;
    const delta = percentageDelta(bucket.total_transactions, median);
    const date = new Date(bucket.bucket_start).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    return {
      ...common,
      eyebrow: `Measured anomaly · ${label}`,
      value: `${compact(bucket.total_transactions)} on ${date}`,
      change: delta,
      comparison: `${delta === null ? "No" : percent(delta)} difference versus the median observed bucket`,
      formula: `${compact(bucket.total_transactions)} bucket transactions ÷ ${compact(median)} median bucket transactions`,
      explanation:
        "This verifies the size and timing of the movement. The public aggregate feed does not provide dated per-service contributors or causal labels, so the Index does not claim why it happened without additional evidence.",
      metric: "transactions",
      limited: true,
      status: "Magnitude verified; cause unverified",
    };
  }

  const metric = metricForText(text);

  if (
    intent === "protocol_comparison" && protocol === "all"
  ) {
    const mpp = data.protocols.mpp.periods[key].stats;
    const x402 = data.protocols.x402.periods[key].stats;
    const mppValue = metricValue(mpp, metric);
    const x402Value = metricValue(x402, metric);
    const total = mppValue + x402Value;
    const leader = x402Value >= mppValue ? "x402" : "MPP";
    const share = total ? (Math.max(mppValue, x402Value) / total) * 100 : 0;
    const formatter = metric === "volume" || metric === "average" ? usd : compact;
    return {
      ...common,
      eyebrow: `${metric === "volume" ? "USD volume" : metric === "average" ? "Average payment" : "Transaction"} comparison · ${range}`,
      value: `${leader} ${share.toFixed(1)}% share`,
      change: null,
      comparison: `${leader} leads the combined observed total`,
      formula: `MPP ${formatter(mppValue)} · x402 ${formatter(x402Value)}`,
      explanation:
        "Both protocols use the same requested window. Counts remain source-indexed and combined payer or server identities are not cross-protocol deduplicated.",
      metric,
      chartProtocols: ["mpp", "x402"],
    };
  }

  if (intent === "growth") {
    if (protocol === "all" && /\bmpp\b/.test(text) && /\bx402\b|\b402\b/.test(text)) {
      const mppTrend = trendForBuckets(data.protocols.mpp.periods[key].buckets, metric);
      const x402Trend = trendForBuckets(data.protocols.x402.periods[key].buckets, metric);
      return {
        ...common,
        eyebrow: `${metric === "volume" ? "Volume" : "Transaction"} trend · ${range}`,
        value: `MPP ${mppTrend === null ? "n/a" : percent(mppTrend)} · x402 ${x402Trend === null ? "n/a" : percent(x402Trend)}`,
        change: null,
        comparison: "Average activity in the last third of the window versus the first third",
        formula: "(last-segment average − first-segment average) ÷ first-segment average",
        explanation:
          "This is a within-window observed trend, not a forecast and not a comparison with an overlapping rolling total.",
        metric,
        chartProtocols: ["mpp", "x402"],
      };
    }
    const trend = trendForBuckets(period.buckets, metric);
    return {
      ...common,
      eyebrow: `${label} ${metric === "volume" ? "volume" : "transaction"} trend · ${range}`,
      value: trend === null ? "Not enough buckets" : percent(trend),
      change: null,
      comparison: "Average activity in the last third of the window versus the first third",
      formula: "(last-segment average − first-segment average) ÷ first-segment average",
      explanation:
        "This is a within-window observed trend. It describes indexed activity and does not imply organic adoption or future growth.",
      metric,
      limited: trend === null,
      status: trend === null ? "Insufficient time buckets" : undefined,
    };
  }

  if (metric === "average") {
    const average = current.totalTransactions
      ? current.totalVolume / current.totalTransactions
      : 0;
    const asksForThirtyDayChange =
      days !== 30 &&
      /\b(30\s*(days?|d)|one\s*month|past month|last month)\b/.test(text) &&
      asksForChange(text);
    const thirtyDayTrend = asksForThirtyDayChange
      ? trendForBuckets(protocolData.periods["30"].buckets, "average")
      : null;
    return {
      ...common,
      eyebrow: `Average payment · ${range}`,
      value: usd(average, true),
      change: thirtyDayTrend,
      comparison:
        asksForThirtyDayChange && thirtyDayTrend !== null
          ? `30-day payment-size trend: ${percent(thirtyDayTrend)}, comparing the last third with the first third`
          : `${label} observed payment size`,
      formula:
        asksForThirtyDayChange
          ? `${usd(current.totalVolume)} ÷ ${compact(current.totalTransactions)} payments; 30-day trend = last-segment average ÷ first-segment average − 1`
          : `${usd(current.totalVolume)} ÷ ${compact(current.totalTransactions)} successful transactions`,
      explanation:
        "Average payment size measures stablecoin settlement value per successful indexed payment. It excludes network fees and unrelated transfers. The 30-day change, when requested, is a within-window bucket trend rather than a comparison between overlapping rolling totals.",
      metric,
    };
  }

  if (metric === "buyers") {
    return {
      ...common,
      eyebrow: `Active payer addresses · ${range}`,
      value: compact(current.uniqueSenders),
      change: null,
      comparison: protocol === "all" ? "Protocol-level sum; not cross-protocol deduplicated" : "Distinct source-reported payer identifiers",
      formula: `${compact(current.uniqueSenders)} distinct network-normalized payer addresses`,
      explanation:
        "This is not a count of people or autonomous agents. One actor may use several addresses, several actors may share one, and combined protocol identities may overlap.",
      metric,
    };
  }

  if (intent === "top_service") {
    const top = protocolData.services[key][0];
    if (top) {
      const share = current.totalTransactions
        ? (top.stats.transactions / current.totalTransactions) * 100
        : 0;
      return {
        ...common,
        eyebrow: `Leading indexed service · ${range}`,
        value: top.name,
        change: null,
        comparison: `${share.toFixed(1)}% of observed ${label} transactions`,
        formula: `${compact(top.stats.transactions)} transactions · ${usd(top.stats.volume)} volume`,
        explanation:
          "The ranking uses successful transactions in the selected source directory. A service indexed on both protocols can appear separately.",
        metric: "transactions",
      };
    }
  }

  if (metric === "servers") {
    return {
      ...common,
      eyebrow: `Active server identities · ${range}`,
      value: compact(current.uniqueRecipients),
      change: null,
      comparison: protocol === "all" ? "Protocol-level sum; not unique companies" : "Distinct active payment recipients",
      formula: `${compact(current.uniqueRecipients)} distinct source-reported recipient identities`,
      explanation:
        "This counts recipient identities with observed payments in the selected window. It differs from indexed service records, which count named directory origins.",
      metric,
    };
  }

  if (metric === "volume") {
    return {
      ...common,
      eyebrow: `USD payment volume · ${range}`,
      value: usd(current.totalVolume),
      change: null,
      comparison: `${label} total observed settlement value`,
      formula: `Sum of ${compact(current.totalTransactions)} successful payment values`,
      explanation:
        "Volume is the recorded stablecoin value of successful protocol-indexed payments in the requested window.",
      metric,
    };
  }

  const divisor = coverageDays(period.buckets, days);
  return {
    ...common,
    eyebrow: `Successful transactions · ${range}`,
    value: compact(current.totalTransactions),
    change: null,
    comparison: `${compact(current.totalTransactions / divisor)} average transactions per day`,
    formula: `${compact(current.totalTransactions)} observed successful payment events`,
    explanation:
      `This counts successful ${label} payments exposed by the selected public indexes. It is raw observed activity, not a quality-adjusted adoption estimate.`,
    metric: "transactions",
  };
}

function parseProtocol(value: unknown): ProtocolKey {
  return value === "mpp" || value === "x402" ? value : "all";
}

function parseWindow(value: unknown): WindowDays {
  return value === 0 || value === 1 || value === 7 ? value : 30;
}

export async function GET() {
  return Response.json({
    endpoint: "/api/ask",
    method: "POST",
    accepts: { question: "string", protocol: ["all", "mpp", "x402"], windowDays: [0, 1, 7, 30] },
    coverage: [
      "totals",
      "averages",
      "protocol comparisons",
      "within-window trends",
      "service rankings",
      "measured anomalies",
      "cohort retention when verified identity coverage is available",
    ],
    evidenceGates: ["cohort retention before identity backfill", "wallet attribution", "autonomous execution"],
  });
}

export async function POST(request: Request) {
  const rateLimit = await checkPublicRateLimit(request, "ask", {
    limit: 30,
    windowSeconds: 600,
  });
  const responseHeaders = rateLimitHeaders(rateLimit);
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error:
          "You have reached the public-beta question limit. Please try again in a few minutes.",
      },
      {
        status: 429,
        headers: {
          ...responseHeaders,
          "Retry-After": String(
            Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
          ),
        },
      },
    );
  }

  try {
    const body = (await request.json()) as {
      question?: unknown;
      protocol?: unknown;
      windowDays?: unknown;
    };
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question || question.length > 500) {
      return Response.json(
        { error: "Question must contain between 1 and 500 characters." },
        { status: 400 },
      );
    }
    const snapshotResponse = await getNetworkSnapshot();
    const snapshot = (await snapshotResponse.json()) as ExplorerData;
    const answer = await answerQuestion(
      snapshot,
      question,
      parseProtocol(body.protocol),
      parseWindow(body.windowDays),
    );
    return Response.json(answer, {
      headers: { ...responseHeaders, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The analysis service is temporarily unavailable.",
      },
      { status: 502, headers: responseHeaders },
    );
  }
}
