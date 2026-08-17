"use client";

import { FormEvent, useEffect, useId, useMemo, useState } from "react";

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
  protocol: "mpp" | "x402";
  network: string;
  stats: {
    transactions: number;
    volume: number;
    buyers: number;
    latestTx: string;
  };
};

type Period = {
  stats: Stats;
  buckets: Bucket[];
  rangeStart: string | null;
  rangeEnd: string | null;
};

type ProtocolKey = "all" | "mpp" | "x402";

type ProtocolData = {
  source: string;
  live: boolean;
  disclosure: string;
  measurementLabel: string;
  volumeLabel: string;
  volumeComparable: boolean;
  periods: Record<"0" | "1" | "7" | "30", Period>;
  services: Record<"0" | "1" | "7" | "30", Service[]>;
};

type ExplorerData = {
  source: string;
  live: boolean;
  asOf: string;
  protocols: Record<ProtocolKey, ProtocolData>;
};

type DirectoryData = {
  items: Service[];
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
  sourceTotals: {
    mpp: number;
    x402: number;
  };
  disclosure: string;
  asOf: string;
};

type SubmissionResult = {
  id: string;
  serviceName: string;
  status: string;
  verificationMessage: string | null;
  verification: {
    url: string;
    body: Record<string, string>;
    note: string;
  };
};

type CohortMatrix = {
  available: boolean;
  role: "payer" | "payee";
  protocol: ProtocolKey;
  mode: "activity" | "acquisition";
  rows: Array<{
    cohortMonth: string;
    cohortSize: number;
    cells: Array<{
      offset: number;
      calendarMonth: string;
      retained: number;
      rate: number;
    }>;
    leftCensored: boolean;
  }>;
  columns: number[];
  coverageStart: string | null;
  coverageEnd: string | null;
  completeThrough: string | null;
  sources: string[];
  definition: string;
  limitation: string;
};

type Answer = {
  eyebrow: string;
  value: string;
  change: number | null;
  comparison: string;
  formula: string;
  explanation: string;
  days: 0 | 1 | 7 | 30;
  metric: "average" | "volume" | "transactions" | "buyers" | "servers";
  protocol: ProtocolKey;
  limited?: boolean;
  status?: string;
  visualization?: "series" | "cohort" | "none";
  chartProtocols?: ProtocolKey[];
  cohort?: CohortMatrix;
  source?: string;
  asOf?: string;
};

const PERIODS = [
  { days: 1 as const, label: "24h", disabled: false },
  { days: 7 as const, label: "7d", disabled: false },
  { days: 30 as const, label: "30d", disabled: false },
  { days: 0 as const, label: "All", disabled: false },
];

const QUESTIONS = [
  "Compare MPP and x402 growth over 30 days",
  "Why did MPP transactions spike on July 27?",
  "Show buyer cohort retention over 12 months",
];

const EMPTY_PROTOCOL: ProtocolData = {
  source: "Waiting for direct evidence",
  live: false,
  disclosure: "No placeholder values are shown while live data loads.",
  measurementLabel: "Direct-source observation",
  volumeLabel: "Value",
  volumeComparable: false,
  periods: {
    "0": {
      stats: { totalTransactions: 0, totalVolume: 0, uniqueSenders: 0, uniqueRecipients: 0 },
      buckets: [],
      rangeStart: null,
      rangeEnd: null,
    },
    "1": {
      stats: { totalTransactions: 0, totalVolume: 0, uniqueSenders: 0, uniqueRecipients: 0 },
      buckets: [],
      rangeStart: null,
      rangeEnd: null,
    },
    "7": {
      stats: { totalTransactions: 0, totalVolume: 0, uniqueSenders: 0, uniqueRecipients: 0 },
      buckets: [],
      rangeStart: null,
      rangeEnd: null,
    },
    "30": {
      stats: { totalTransactions: 0, totalVolume: 0, uniqueSenders: 0, uniqueRecipients: 0 },
      buckets: [],
      rangeStart: null,
      rangeEnd: null,
    },
  },
  services: { "0": [], "1": [], "7": [], "30": [] },
};

const FALLBACK: ExplorerData = {
  source: "Connecting to direct chain evidence",
  live: false,
  asOf: "",
  protocols: {
    all: EMPTY_PROTOCOL,
    mpp: EMPTY_PROTOCOL,
    x402: EMPTY_PROTOCOL,
  },
};

const EMPTY_DIRECTORY: DirectoryData = {
  items: [],
  total: 0,
  totalPages: 1,
  page: 1,
  pageSize: 20,
  sourceTotals: { mpp: 0, x402: 0 },
  disclosure: "Connecting to the public service indexes.",
  asOf: "",
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
  }).format(value);
}

function compactUsd(value: number) {
  return value >= 1000 ? `$${compact(value)}` : usd(value);
}

function relativeTime(dateString: string) {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(dateString).getTime()) / 60000),
  );
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function exactTime(dateString: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(dateString));
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  lines.forEach((item, index) => context.fillText(item, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function percentageDelta(value: number, baseline: number) {
  if (!baseline) return null;
  return ((value - baseline) / baseline) * 100;
}

function periodLabel(days: 0 | 1 | 7 | 30) {
  if (days === 0) return "Available history";
  if (days === 1) return "24 hours";
  return `${days} days`;
}

function periodDays(days: 0 | 1 | 7 | 30, buckets: Bucket[]) {
  if (days) return days;
  const times = buckets
    .map((bucket) => new Date(bucket.bucket_start).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (times.length < 2) return 1;
  return Math.max(1, (times.at(-1)! - times[0]) / 86_400_000 + 1);
}

function coverageStart(buckets: Bucket[]) {
  const first = [...buckets]
    .map((bucket) => bucket.bucket_start)
    .sort()[0];
  if (!first) return "the first available record";
  return new Date(first).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function getTimeframes(question: string): {
  primary: 0 | 1 | 7 | 30;
  comparison: 0 | 1 | 7 | 30 | null;
} {
  const text = question.toLowerCase();
  const occurrences: Array<{ days: 0 | 1 | 7 | 30; index: number }> = [];
  const patterns: Array<{ days: 0 | 1 | 7 | 30; pattern: RegExp }> = [
    {
      days: 0,
      pattern: /\b(?:all[ -]?time|all history|entire history|since inception)\b/g,
    },
    {
      days: 1,
      pattern: /\b(?:24\s*(?:hours?|hrs?|h)|today|1\s*day|one\s*day)\b/g,
    },
    {
      days: 7,
      pattern: /\b(?:7\s*(?:days?|d)|one\s*week|a\s*week|week)\b/g,
    },
    {
      days: 30,
      pattern: /\b(?:30\s*(?:days?|d)|one\s*month|a\s*month|month)\b/g,
    },
  ];

  patterns.forEach(({ days, pattern }) => {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) occurrences.push({ days, index: match.index });
    }
  });

  occurrences.sort((a, b) => a.index - b.index);
  const primary = occurrences[0]?.days ?? 1;
  const comparison =
    occurrences.find((occurrence) => occurrence.days !== primary)?.days ??
    (primary === 30 ? null : 30);

  return { primary, comparison };
}

function protocolForQuestion(
  question: string,
  selected: ProtocolKey,
): ProtocolKey {
  const text = question.toLowerCase();
  const mentionsMpp = /\bmpp\b/.test(text);
  const mentionsX402 = /\bx402\b|\b402\b/.test(text);
  if (mentionsMpp && mentionsX402) return "all";
  if (mentionsMpp) return "mpp";
  if (mentionsX402) return "x402";
  return selected;
}

function answerQuestion(
  data: ExplorerData,
  question: string,
  selectedProtocol: ProtocolKey,
): Answer {
  const text = question.toLowerCase();
  const protocol = protocolForQuestion(text, selectedProtocol);
  const protocolData = data.protocols[protocol];
  const { primary: days, comparison: comparisonDays } = getTimeframes(text);
  const current =
    protocolData.periods[String(days) as "0" | "1" | "7" | "30"].stats;
  const baseline = comparisonDays
    ? protocolData.periods[String(comparisonDays) as "0" | "1" | "7" | "30"].stats
    : null;
  const periodLabel = days === 0 ? "available indexed history" : days === 1 ? "past 24 hours" : `past ${days} days`;
  const comparisonLabel =
    comparisonDays === 1
      ? "the 24-hour period"
      : comparisonDays
        ? comparisonDays === 0
          ? "available indexed history"
          : `the aggregate ${comparisonDays}-day period`
        : null;

  if (/\b(previous|prior|preceding)\b/.test(text)) {
    return {
      eyebrow: "Coverage-limited comparison",
      value: "Not computed",
      change: null,
      comparison: "A non-overlapping prior-period series is not exposed by the current aggregate feeds.",
      formula: "Requires daily source rows for both complete periods",
      explanation:
        "The index will not substitute an overlapping rolling average. Ask for a 24h, 7d, or 30d aggregate comparison, or inspect the displayed time series while historical period storage is added.",
      days,
      metric: "transactions",
      protocol,
      limited: true,
    };
  }

  if (/\b(cohort|retention|wallet|autonomous|autonomy)\b/.test(text)) {
    return {
      eyebrow: "Identity analysis · evidence required",
      value: "Awaiting identity backfill",
      change: null,
      comparison: "The loaded aggregate snapshot does not contain identity-level history or attribution evidence.",
      formula: "Requires independently indexed payment identities over time",
      explanation:
        "The Index does not estimate cohorts, wallet providers, or autonomous execution from rolling aggregate counts. The live analysis service explains the exact evidence gate when connected.",
      days,
      metric: "buyers",
      protocol,
      limited: true,
      status: "Identity evidence required",
      visualization: "none",
    };
  }

  if (
    protocol === "all" &&
    /\bmpp\b/.test(text) &&
    (/\bx402\b/.test(text) || /\b402\b/.test(text)) &&
    (text.includes("compare") ||
      text.includes("versus") ||
      text.includes(" vs ") ||
      text.includes("share")) &&
    !/\b(growth|grow|trend|change rate|increas|decreas)\b/.test(text)
  ) {
    const mpp = data.protocols.mpp.periods[String(days) as "0" | "1" | "7" | "30"].stats;
    const x402 = data.protocols.x402.periods[String(days) as "0" | "1" | "7" | "30"].stats;
    const compareVolume =
      text.includes("volume") ||
      text.includes("usd") ||
      text.includes("dollar") ||
      text.includes("spend");
    const mppValue = compareVolume ? mpp.totalVolume : mpp.totalTransactions;
    const x402Value = compareVolume ? x402.totalVolume : x402.totalTransactions;
    if (compareVolume) {
      return {
        eyebrow: `Value comparison · ${periodLabel}`,
        value: "Not directly comparable",
        change: null,
        comparison: `MPP payment value ${usd(mppValue)} · x402 payment value ${usd(x402Value)}`,
        formula: "Values shown separately; no combined share",
        explanation:
          "MPP is protocol-attributed payment value. x402 counts each reconstructed payer-to-terminal-recipient chain once at the payer's original amount. Totals remain separate because protocol and network coverage differ.",
        days,
        metric: "volume",
        protocol,
        limited: true,
        status: "Different measurement units",
        visualization: "none",
      };
    }
    const total = mppValue + x402Value;
    const leader = x402Value >= mppValue ? "x402" : "MPP";
    const leaderValue = Math.max(x402Value, mppValue);
    const share = total ? (leaderValue / total) * 100 : 0;
    return {
      eyebrow: `${compareVolume ? "Volume" : "Transaction"} share · ${periodLabel}`,
      value: `${leader} ${share.toFixed(1)}%`,
      change: null,
      comparison: `${leader} leads observed ${compareVolume ? "USD volume" : "transactions"}`,
      formula: compareVolume
        ? `MPP ${usd(mppValue)} · x402 ${usd(x402Value)}`
        : `MPP ${compact(mppValue)} · x402 ${compact(x402Value)}`,
      explanation:
        "Both protocols use the same exact rolling window and are reconstructed from direct chain evidence.",
      days,
      metric: compareVolume ? "volume" : "transactions",
      protocol,
    };
  }

  if (
    (text.includes("average") || text.includes("avg") || text.includes("size")) &&
    (text.includes("transaction") || text.includes("payment"))
  ) {
    if (protocol === "all") {
      return {
        eyebrow: `Average value · ${periodLabel}`,
        value: "Not combined",
        change: null,
        comparison: "Select MPP or x402 to inspect its protocol-specific average.",
        formula: "No combined numerator or denominator",
        explanation:
          "MPP and x402 payment values use protocol-specific attribution rules, so select a protocol for its average.",
        days,
        metric: "average",
        protocol,
        limited: true,
        status: "Different measurement units",
        visualization: "none",
      };
    }
    const value = current.totalVolume / current.totalTransactions;
    const benchmark = baseline
      ? baseline.totalVolume / baseline.totalTransactions
      : null;
    return {
      eyebrow: `${protocol === "mpp" ? "Average MPP payment" : "Average x402 payment"} · ${periodLabel}`,
      value: usd(value, true),
      change: benchmark === null ? null : percentageDelta(value, benchmark),
      comparison: comparisonLabel
        ? `vs the average across ${comparisonLabel}`
        : "aggregate average for the selected period",
      formula: `${usd(current.totalVolume)} ÷ ${compact(current.totalTransactions)} transactions`,
      explanation:
        protocol === "mpp"
          ? "This is identified MPP payment value divided by qualifying payments."
          : "This is payer-originated USDC payment value divided by reconstructed x402 payments. Receive-and-forward chains count once.",
      days,
      metric: "average",
      protocol,
    };
  }

  if (
    text.includes("buyer") ||
    text.includes("agent") ||
    text.includes("sender")
  ) {
    return {
      eyebrow: `Active payer addresses · ${periodLabel}`,
      value: compact(current.uniqueSenders),
      change: baseline
        ? percentageDelta(current.uniqueSenders, baseline.uniqueSenders)
        : null,
      comparison: comparisonLabel
        ? `vs unique agents seen across ${comparisonLabel}`
        : "unique agents in the selected period",
      formula: `${compact(current.uniqueSenders)} distinct paying addresses`,
      explanation:
        "This is not a count of people or autonomous agents. One actor may use several addresses, several actors may share one, and combined protocol identities may overlap.",
      days,
      metric: "buyers",
      protocol,
    };
  }

  if (
    text.includes("server") ||
    text.includes("provider") ||
    text.includes("service")
  ) {
    const services =
      protocolData.services[String(days) as "0" | "1" | "7" | "30"] ??
      protocolData.services["1"];
    const top = services[0];
    if (
      top &&
      (text.includes("top") ||
        text.includes("most") ||
        text.includes("leading") ||
        text.includes("which"))
    ) {
      const share = current.totalTransactions
        ? (top.stats.transactions / current.totalTransactions) * 100
        : 0;
      return {
        eyebrow: `Leading service · ${periodLabel}`,
        value: top.name,
        change: null,
        comparison: `${share.toFixed(1)}% of network transactions`,
        formula: `${compact(top.stats.transactions)} transactions · ${usd(top.stats.volume)} volume`,
        explanation: `${top.name} ranks first by successful transactions in the selected period.`,
        days,
        metric: "transactions",
        protocol,
      };
    }

    return {
      eyebrow: `Observed payment recipients · ${periodLabel}`,
      value: compact(current.uniqueRecipients),
      change: baseline
        ? percentageDelta(
            current.uniqueRecipients,
            baseline.uniqueRecipients,
          )
        : null,
      comparison: comparisonLabel
        ? `vs recipient addresses seen across ${comparisonLabel}`
        : "recipient addresses in the selected period",
      formula: `${compact(current.uniqueRecipients)} distinct payment recipient addresses`,
      explanation:
        protocol === "all"
          ? "This is the sum of recipient addresses reported by both protocol indexes. It is not a count of resolved services or companies, and a recipient active on both may be counted twice."
          : "This counts distinct payment recipients with observed activity, not the smaller directory of resolved service origins.",
      days,
      metric: "servers",
      protocol,
    };
  }

  if (
    text.includes("volume") ||
    text.includes("spend") ||
    text.includes("usd") ||
    text.includes("dollar")
  ) {
    if (protocol === "all") {
      const mpp = data.protocols.mpp.periods[String(days) as "0" | "1" | "7" | "30"].stats;
      const x402 = data.protocols.x402.periods[String(days) as "0" | "1" | "7" | "30"].stats;
      return {
        eyebrow: `Value measurements · ${periodLabel}`,
        value: "Not combined",
        change: null,
        comparison: `MPP payment value ${usd(mpp.totalVolume)} · x402 payment value ${usd(x402.totalVolume)}`,
        formula: "Values shown separately; no combined total",
        explanation:
          "MPP and x402 are reconstructed with protocol-specific methods. The Index keeps totals separate because coverage differs across protocols and networks.",
        days,
        metric: "volume",
        protocol,
        limited: true,
        status: "Different measurement units",
        visualization: "none",
      };
    }
    const divisor = periodDays(days, protocolData.periods[String(days) as "0" | "1" | "7" | "30"].buckets);
    const daily = current.totalVolume / divisor;
    const baselineDaily =
      baseline && comparisonDays
        ? baseline.totalVolume / comparisonDays
        : null;
    return {
      eyebrow: `${protocol === "mpp" ? "MPP payment value" : "x402 payment value"} · ${periodLabel}`,
      value: usd(current.totalVolume),
      change:
        baselineDaily === null ? null : percentageDelta(daily, baselineDaily),
      comparison: comparisonDays
        ? `daily run-rate vs the ${comparisonDays}-day daily average`
        : "total observed volume in the selected period",
      formula: `${compact(current.totalTransactions)} payments settled in the period`,
      explanation:
        protocol === "mpp"
          ? "This is identified MPP payment value observed directly on Tempo."
          : "This is payer-originated USDC value for reconstructed x402 payments involving the maintained facilitator set on Base. Routing chains count once and resolve to the terminal recipient.",
      days,
      metric: "volume",
      protocol,
    };
  }

  const divisor = periodDays(days, protocolData.periods[String(days) as "0" | "1" | "7" | "30"].buckets);
  const daily = current.totalTransactions / divisor;
  const baselineDaily =
    baseline && comparisonDays
      ? baseline.totalTransactions / comparisonDays
      : null;
  return {
    eyebrow: `Observed records · ${periodLabel}`,
    value: compact(current.totalTransactions),
    change:
      baselineDaily === null ? null : percentageDelta(daily, baselineDaily),
    comparison: comparisonDays
      ? `daily run-rate vs the ${comparisonDays}-day daily average`
      : "total successful transactions in the selected period",
    formula: `${compact(Math.round(daily))} transactions per day`,
    explanation:
      `This counts ${protocolData.measurementLabel.toLowerCase()} reconstructed from direct chain evidence.`,
    days,
    metric: "transactions",
    protocol,
  };
}

type MetricKey =
  | "transactions"
  | "volume"
  | "buyers"
  | "servers"
  | "average";

type ChartSeries = {
  key: string;
  label: string;
  className: string;
  buckets: Bucket[];
  metric: MetricKey;
};

function metricValue(bucket: Bucket, metric: MetricKey) {
  if (metric === "volume") return bucket.total_volume;
  if (metric === "buyers") return bucket.unique_senders;
  if (metric === "servers") return bucket.unique_recipients;
  if (metric === "average") {
    return bucket.total_transactions
      ? bucket.total_volume / bucket.total_transactions
      : 0;
  }
  return bucket.total_transactions;
}

function chartNumber(value: number, metric: MetricKey) {
  if (metric === "volume" || metric === "average") {
    return value >= 1000 ? `$${compact(value)}` : usd(value, value < 1);
  }
  return compact(Math.round(value));
}

function chartDate(value: string, days: 0 | 1 | 7 | 30) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: days === 1 ? undefined : "short",
    day: days === 1 ? undefined : "numeric",
    hour: days === 1 ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

function InfoTerm({
  label,
  definition,
  formula,
  example,
}: {
  label: string;
  definition: string;
  formula?: string;
  example?: string;
}) {
  const tooltipId = useId();
  return (
    <span className="infoTerm">
      <span>{label}</span>
      <button
        type="button"
        className="infoTrigger"
        aria-label={`Define ${label}`}
        aria-describedby={tooltipId}
      >
        i
      </button>
      <span className="infoPopover" id={tooltipId} role="tooltip">
        <strong>{label}</strong>
        <span>{definition}</span>
        {formula && (
          <span>
            <b>Formula</b> {formula}
          </span>
        )}
        {example && (
          <span>
            <b>Example</b> {example}
          </span>
        )}
      </span>
    </span>
  );
}

function LabeledBarChart({
  series,
  days,
  yAxisTitle,
  className = "",
}: {
  series: ChartSeries[];
  days: 0 | 1 | 7 | 30;
  yAxisTitle: string;
  className?: string;
}) {
  const sampled = useMemo(() => {
    const points = new Map<
      string,
      { label: string; values: Record<string, number> }
    >();
    series.forEach((item) => {
      item.buckets.forEach((bucket) => {
        const point = points.get(bucket.bucket_start) ?? {
          label: bucket.bucket_start,
          values: {},
        };
        point.values[item.key] = metricValue(bucket, item.metric);
        points.set(bucket.bucket_start, point);
      });
    });
    const ordered = [...points.values()].sort((left, right) =>
      left.label.localeCompare(right.label),
    );
    const target = 18;
    const step = Math.max(1, Math.ceil(ordered.length / target));
    return ordered.filter((_, index) => index % step === 0).slice(-target);
  }, [series]);

  const max = Math.max(
    ...sampled.flatMap((point) => Object.values(point.values)),
    1,
  );
  const tickValues = [max, max * (2 / 3), max * (1 / 3), 0];
  const labelStep = Math.max(1, Math.floor((sampled.length - 1) / 4));

  return (
    <div
      className={`axisChart ${className}`}
      role="img"
      aria-label={`${yAxisTitle} over ${days === 0 ? "available indexed history" : days === 1 ? "the selected 24 hours" : `the selected ${days} days`}`}
    >
      <span className="yAxisCaption">{yAxisTitle}</span>
      <div className="axisChartBody">
        <div className="yTicks" aria-hidden="true">
          {tickValues.map((tick, index) => (
            <span key={`${tick}-${index}`}>{chartNumber(tick, series[0].metric)}</span>
          ))}
        </div>
        <div className="plotArea">
          <div className="gridLines" aria-hidden="true">
            {tickValues.map((_, index) => (
              <i key={index} />
            ))}
          </div>
          {sampled.length ? (
            <div
              className="barGroups"
              style={{ gridTemplateColumns: `repeat(${sampled.length}, minmax(4px, 1fr))` }}
            >
              {sampled.map((point, index) => (
                <div className="barGroup" key={`${point.label}-${index}`}>
                  {series.map((item) => {
                    const value = point.values[item.key] ?? 0;
                    return (
                      <i
                        key={item.key}
                        className={item.className}
                        style={{ height: `${Math.max(1, (value / max) * 100)}%` }}
                        title={`${item.label} · ${chartDate(point.label, days)} · ${chartNumber(value, item.metric)}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <div className="chartEmpty">Waiting for live bucket data</div>
          )}
          <div
            className="xTicks"
            style={{
              gridTemplateColumns: `repeat(${Math.max(sampled.length, 1)}, minmax(4px, 1fr))`,
            }}
            aria-hidden="true"
          >
            {sampled.map((point, index) => (
              <span
                key={`${point.label}-axis`}
                className={
                  index % labelStep === 0 || index === sampled.length - 1
                    ? "visible"
                    : ""
                }
              >
                {chartDate(point.label, days)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="chartAxisMeta">
        <span>Date</span>
      </div>
    </div>
  );
}

function displayMonth(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function CohortHeatmap({ matrix }: { matrix: CohortMatrix }) {
  return (
    <div
      className="cohortHeatmap"
      role="img"
      aria-label={`${matrix.role === "payer" ? "Payer" : "Service"} ${matrix.mode} cohort retention`}
    >
      <div className="cohortScroll">
        <table>
          <thead>
            <tr>
              <th>Cohort</th>
              <th>Identities</th>
              {matrix.columns.map((offset) => (
                <th key={offset}>M+{offset}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.cohortMonth}>
                <th>
                  {displayMonth(row.cohortMonth)}
                  {row.leftCensored ? <sup title="History begins in this cohort month">†</sup> : null}
                </th>
                <td>{compact(row.cohortSize)}</td>
                {matrix.columns.map((offset) => {
                  const cell = row.cells.find((item) => item.offset === offset);
                  return (
                    <td
                      key={offset}
                      className={cell ? "cohortCell" : "cohortCell empty"}
                      style={
                        cell
                          ? { backgroundColor: `rgba(255, 107, 61, ${0.08 + (cell.rate / 100) * 0.58})` }
                          : undefined
                      }
                      title={
                        cell
                          ? `${displayMonth(cell.calendarMonth)}: ${cell.retained} retained (${cell.rate.toFixed(1)}%)`
                          : "Month not yet complete"
                      }
                    >
                      {cell ? `${cell.rate.toFixed(cell.rate < 10 ? 1 : 0)}%` : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cohortLegend">
        <span>Lower retention</span>
        <i />
        <i />
        <i />
        <i />
        <span>Higher retention</span>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  definition,
  formula,
  example,
}: {
  label: string;
  value: string;
  note: string;
  definition: string;
  formula?: string;
  example?: string;
}) {
  return (
    <article className="metricCard">
      <div className="metricTop">
        <InfoTerm
          label={label}
          definition={definition}
          formula={formula}
          example={example}
        />
        <span className="metricArrow">↗</span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function paginationWindow(current: number, total: number) {
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  return [...pages]
    .filter((page) => page >= 1 && page <= total)
    .sort((left, right) => left - right);
}

function ViewToggle({
  machineMode,
  onChange,
}: {
  machineMode: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="viewToggle" aria-label="Choose human or machine view">
      <button
        className={!machineMode ? "active" : ""}
        onClick={() => onChange(false)}
        aria-pressed={!machineMode}
      >
        Human
      </button>
      <button
        className={machineMode ? "active" : ""}
        onClick={() => onChange(true)}
        aria-pressed={machineMode}
      >
        Machine
      </button>
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<ExplorerData>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [protocol, setProtocol] = useState<ProtocolKey>("all");
  const [period, setPeriod] = useState<0 | 1 | 7 | 30>(30);
  const [question, setQuestion] = useState(
    "Compare MPP and x402 transaction activity over the last 7 days.",
  );
  const [submittedQuestion, setSubmittedQuestion] = useState(question);
  const [hasAsked, setHasAsked] = useState(false);
  const [remoteAnswer, setRemoteAnswer] = useState<Answer | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const [answerRevision, setAnswerRevision] = useState(0);
  const [justAnswered, setJustAnswered] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const [sort, setSort] = useState<"transactions" | "volume" | "buyers">(
    "transactions",
  );
  const [directory, setDirectory] =
    useState<DirectoryData>(EMPTY_DIRECTORY);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState("");
  const [servicePage, setServicePage] = useState(1);
  const [machineMode, setMachineMode] = useState(false);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [submissionLoading, setSubmissionLoading] = useState(false);
  const [submissionError, setSubmissionError] = useState("");
  const [submissionResult, setSubmissionResult] =
    useState<SubmissionResult | null>(null);
  const [submissionForm, setSubmissionForm] = useState({
    serviceName: "",
    canonicalUrl: "",
    protocol: "mpp",
    network: "Tempo",
    protocolEndpoint: "",
    contactEmail: "",
  });

  useEffect(() => {
    let active = true;
    fetch("/api/network")
      .then((response) => {
        if (!response.ok) throw new Error("Data request failed");
        return response.json();
      })
      .then((nextData: ExplorerData) => {
        if (active) setData(nextData);
      })
      .catch(() => {
        if (active) setData(FALLBACK);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const sharedQuestion = parameters.get("q")?.trim();
    if (!sharedQuestion) return;
    const sharedProtocol = (["all", "mpp", "x402"].includes(parameters.get("protocol") ?? "")
      ? parameters.get("protocol")
      : "all") as ProtocolKey;
    const requestedDays = Number(parameters.get("days"));
    const sharedPeriod = ([1, 7, 30].includes(requestedDays)
      ? requestedDays
      : 30) as 0 | 1 | 7 | 30;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setQuestion(sharedQuestion);
      setProtocol(sharedProtocol);
      setPeriod(sharedPeriod);
      void runQuestion(sharedQuestion, sharedProtocol, sharedPeriod);
    });
    return () => {
      active = false;
    };
    // A shared query should run once on initial navigation, not after every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setDirectoryLoading(true);
        setDirectoryError("");
      }
    });
    const parameters = new URLSearchParams({
      protocol,
      days: String(period),
      page: String(servicePage),
      pageSize: "20",
      sort,
    });
    fetch(`/api/services?${parameters.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error("Directory request failed");
        return response.json();
      })
      .then((nextDirectory: DirectoryData) => {
        if (active) setDirectory(nextDirectory);
      })
      .catch(() => {
        if (active) {
          setDirectoryError(
            "The complete service directory is temporarily unavailable.",
          );
        }
      })
      .finally(() => {
        if (active) setDirectoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [period, protocol, servicePage, sort]);

  const selectedKey = String(period) as "0" | "1" | "7" | "30";
  const selectedProtocolData = data.protocols[protocol];
  const selected = selectedProtocolData.periods[selectedKey];
  const allTimeAvailable = Boolean(
    selectedProtocolData.periods["0"].rangeStart &&
      selectedProtocolData.periods["0"].rangeEnd,
  );
  const allTimeUnavailableTitle =
    protocol === "mpp"
      ? "MPP history is still loading"
      : protocol === "x402"
        ? "x402 all-time identity history is still being backfilled"
        : "Combined all-time data will unlock after x402 identity history is complete";
  const fallbackAnswer = useMemo(
    () => answerQuestion(data, submittedQuestion, protocol),
    [data, submittedQuestion, protocol],
  );
  const answer = remoteAnswer ?? fallbackAnswer;
  const answerBuckets =
    data.protocols[answer.protocol].periods[
      String(answer.days) as "0" | "1" | "7" | "30"
    ].buckets;
  const answerSeries: ChartSeries[] = (answer.chartProtocols ?? [answer.protocol]).map(
    (item) => ({
      key: item,
      label: PROTOCOL_LABELS[item],
      className:
        item === "mpp"
          ? "seriesMpp"
          : item === "x402"
            ? "seriesX402"
            : "seriesAll",
      buckets:
        item === answer.protocol
          ? answerBuckets
          : data.protocols[item].periods[
              String(answer.days) as "0" | "1" | "7" | "30"
            ].buckets,
      metric: answer.metric,
    }),
  );
  const selectedPeriodDays = periodDays(period, selected.buckets);
  const average = selectedProtocolData.volumeComparable && selected.stats.totalTransactions
    ? selected.stats.totalVolume / selected.stats.totalTransactions
    : 0;
  const mppSelected = data.protocols.mpp.periods[selectedKey].stats;
  const x402Selected = data.protocols.x402.periods[selectedKey].stats;
  const combinedTransactions =
    mppSelected.totalTransactions + x402Selected.totalTransactions;

  function protocolHasAllTime(nextProtocol: ProtocolKey) {
    const nextPeriod = data.protocols[nextProtocol].periods["0"];
    return Boolean(nextPeriod.rangeStart && nextPeriod.rangeEnd);
  }

  function selectProtocol(nextProtocol: ProtocolKey) {
    setProtocol(nextProtocol);
    if (period === 0 && !protocolHasAllTime(nextProtocol)) setPeriod(30);
    setServicePage(1);
  }

  async function runQuestion(
    nextQuestion: string,
    requestedProtocol = protocol,
    requestedPeriod = period,
  ) {
    const trimmed = nextQuestion.trim();
    if (!trimmed) return;
    setSubmittedQuestion(trimmed);
    const nextProtocol = protocolForQuestion(trimmed, requestedProtocol);
    const nextPeriod =
      requestedPeriod === 0 && !protocolHasAllTime(nextProtocol)
        ? 30
        : requestedPeriod;
    selectProtocol(nextProtocol);
    setRemoteAnswer(null);
    setAnswerError("");
    setHasAsked(true);
    setAnswering(true);
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          protocol: nextProtocol,
          windowDays: nextPeriod,
        }),
      });
      if (!response.ok) throw new Error("Analysis request failed");
      const nextAnswer = (await response.json()) as Answer;
      setRemoteAnswer(nextAnswer);
      setAnswerRevision((revision) => revision + 1);
      setJustAnswered(true);
      window.setTimeout(() => setJustAnswered(false), 1400);
    } catch {
      setAnswerError(
        "Live analysis is temporarily unavailable. The visible fallback uses the loaded snapshot.",
      );
      setAnswerRevision((revision) => revision + 1);
    } finally {
      setAnswering(false);
    }
  }

  function submitQuestion(event: FormEvent) {
    event.preventDefault();
    runQuestion(question);
  }

  function liveAnswerUrl() {
    const url = new URL(window.location.origin);
    url.searchParams.set("q", submittedQuestion);
    url.searchParams.set("protocol", answer.protocol);
    url.searchParams.set("days", String(answer.days));
    url.hash = "ask-index";
    return url.toString();
  }

  async function copyAnswerLink() {
    await navigator.clipboard.writeText(liveAnswerUrl());
    setShareStatus("Live answer link copied");
    window.setTimeout(() => setShareStatus(""), 1800);
  }

  function shareAnswer(destination: "x" | "linkedin") {
    const url = liveAnswerUrl();
    const text = `${submittedQuestion} — ${answer.value} | The Agentic Payments Index`;
    const shareUrl =
      destination === "x"
        ? `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
        : `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
    window.open(shareUrl, "_blank", "noopener,noreferrer,width=760,height=680");
  }

  function downloadAnswerCard() {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 630;
    const context = canvas.getContext("2d");
    if (!context) return;
    const gradient = context.createLinearGradient(0, 0, 1200, 630);
    gradient.addColorStop(0, "#120b09");
    gradient.addColorStop(0.7, "#1b0d09");
    gradient.addColorStop(1, "#37150c");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1200, 630);
    context.strokeStyle = "rgba(255,107,61,.5)";
    context.lineWidth = 2;
    context.strokeRect(34, 34, 1132, 562);
    context.fillStyle = "#ff6b3d";
    context.font = "600 24px ui-monospace, monospace";
    context.fillText("THE AGENTIC PAYMENTS INDEX", 82, 98);
    context.fillStyle = "#a99a92";
    context.font = "28px Arial, sans-serif";
    const afterQuestion = drawWrappedText(context, submittedQuestion, 82, 180, 1010, 42, 3);
    context.fillStyle = "#fff7ef";
    context.font = "500 88px Arial, sans-serif";
    const safeValue = answer.value.length > 24 ? `${answer.value.slice(0, 24)}…` : answer.value;
    context.fillText(safeValue, 82, Math.max(355, afterQuestion + 82));
    context.fillStyle = "#b7aaa2";
    context.font = "26px Arial, sans-serif";
    drawWrappedText(context, answer.comparison, 82, 475, 1010, 34, 2);
    context.fillStyle = "#b8ed72";
    context.font = "600 18px ui-monospace, monospace";
    context.fillText("VERIFIED CALCULATION", 82, 557);
    context.fillStyle = "#877870";
    context.textAlign = "right";
    context.fillText("agenticpaymentsindex.org", 1118, 557);
    const link = document.createElement("a");
    link.download = `agentic-payments-index-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    setShareStatus("Insight card created");
    window.setTimeout(() => setShareStatus(""), 1800);
  }

  async function submitService(event: FormEvent) {
    event.preventDefault();
    setSubmissionLoading(true);
    setSubmissionError("");
    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submissionForm),
      });
      const payload = (await response.json()) as SubmissionResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Submission failed");
      setSubmissionResult(payload);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "Submission failed.");
    } finally {
      setSubmissionLoading(false);
    }
  }

  async function verifyService() {
    if (!submissionResult) return;
    setSubmissionLoading(true);
    setSubmissionError("");
    try {
      const response = await fetch("/api/submissions/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: submissionResult.id }),
      });
      const payload = (await response.json()) as SubmissionResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Verification failed");
      setSubmissionResult(payload);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "Verification failed.");
    } finally {
      setSubmissionLoading(false);
    }
  }

  if (machineMode) {
    const machinePayload = {
      index: "the-agentic-payments-index",
      schemaVersion: "0.3.0",
      asOf: data.asOf || null,
      selectedView: {
        protocol,
        windowDays: period,
        stats: selected.stats,
      },
      coverage: {
        indexedServiceRecords: directory.total,
        activePayerAddresses: selected.stats.uniqueSenders,
        activeRecipientAddresses: selected.stats.uniqueRecipients,
        mppIndexedOrigins: directory.sourceTotals.mpp,
        x402IndexedOrigins: directory.sourceTotals.x402,
        caveat: directory.disclosure,
      },
      provenance: {
        mpp: data.protocols.mpp.source,
        x402: data.protocols.x402.source,
        adjustmentStatus:
          "Raw observed activity. Quality-adjusted classification is not yet applied.",
      },
      endpoints: {
        network: "/api/network",
        directory:
          `/api/services?protocol=${protocol}&days=${period}&page=1&pageSize=20&sort=${sort}`,
        manifest: "/api/agent",
        ask: "/api/ask",
        walletRegistry: "/api/wallets",
        submitService: "/api/submissions",
      },
    };

    return (
      <main className="machineShell">
        <aside className="publicBetaBar" aria-label="Public beta notice">
          <strong>Public beta</strong>
          <span>
            Direct-chain 24h, 7d, and 30d windows are live. MPP history is
            available; x402 identity history is still being backfilled.
          </span>
          <a href="#machine-evidence">Coverage details ↓</a>
        </aside>
        <nav className="machineTopbar">
          <a className="brand" href="#machine-top">
            <span className="brandMark" aria-hidden="true">
              <i />
              <i />
            </span>
            <span>THE AGENTIC PAYMENTS INDEX</span>
          </a>
          <span>application/json · read-only · public</span>
        </nav>
        <section className="machineHero" id="machine-top">
          <div className="machineIntro">
            <span className="sectionNumber">Machine-readable view</span>
            <h1>
              One index.
              <br />
              Explicit evidence.
            </h1>
            <p>
              This is the same public observation layer exposed to software:
              stable fields, declared sources, visible freshness, and coverage
              limits that travel with the number.
            </p>
            <div className="machineEndpointList">
              <a href="/api/network" target="_blank">
                GET /api/network <span>↗</span>
              </a>
              <a
                href={`/api/services?protocol=${protocol}&days=${period}&page=1&pageSize=20&sort=${sort}`}
                target="_blank"
              >
                GET /api/services <span>↗</span>
              </a>
              <a href="/api/agent" target="_blank">
                GET /api/agent <span>↗</span>
              </a>
              <a href="/api/ask" target="_blank">
                POST /api/ask <span>↗</span>
              </a>
              <a href="/api/wallets" target="_blank">
                GET /api/wallets <span>↗</span>
              </a>
              <a href="/api/submissions" target="_blank">
                POST /api/submissions <span>↗</span>
              </a>
            </div>
          </div>
          <div className="machineConsole">
            <div className="machineConsoleHead">
              <span>index.snapshot.json</span>
              <span className={data.live ? "machineHealthy" : ""}>
                {data.live ? "200 OK" : "503 SOURCE UNAVAILABLE"}
              </span>
            </div>
            <pre>{JSON.stringify(machinePayload, null, 2)}</pre>
          </div>
        </section>
        <section className="machineSchema" id="machine-evidence">
          <article>
            <span>01 / Observe</span>
            <strong>Raw activity</strong>
            <p>Protocol-native transactions, value, actors, and timestamps.</p>
          </article>
          <article>
            <span>02 / Resolve</span>
            <strong>Service records</strong>
            <p>Paginated origins remain distinct from raw recipient counts.</p>
          </article>
          <article>
            <span>03 / Qualify</span>
            <strong>Adjustment state</strong>
            <p>Raw totals stay explicit until adjustment rules and confidence ranges ship.</p>
          </article>
          <article>
            <span>04 / Cite</span>
            <strong>Provenance</strong>
            <p>Source, formula, window, freshness, and limitations travel together.</p>
          </article>
        </section>
        <footer className="machineFooter">
          <span>Built for agents, analysts, and reproducible research.</span>
          <span>{data.asOf ? `Snapshot ${data.asOf}` : "Connecting"}</span>
        </footer>
        <ViewToggle machineMode onChange={setMachineMode} />
      </main>
    );
  }

  return (
    <main>
      <aside className="publicBetaBar" aria-label="Public beta notice">
        <strong>Public beta</strong>
        <span>
          Direct-chain 24h, 7d, and 30d windows are live. MPP history is
          available; x402 identity history is still being backfilled.
        </span>
        <a href="/coverage">Coverage details ↗</a>
      </aside>
      <nav className="topbar" aria-label="Primary navigation">
        <a
          className="brand"
          href="#top"
          aria-label="The Agentic Payments Index home"
        >
          <span className="brandMark" aria-hidden="true">
            <i />
            <i />
          </span>
            <span className="brandCopy">
              <span>THE AGENTIC PAYMENTS INDEX</span>
              <small>Independent Tempo + Base observations</small>
          </span>
        </a>
        <div className="navLinks">
          <a href="#pulse">Network</a>
          <a href="#services">Services</a>
          <a href="/coverage">Coverage</a>
          <a href="/about">About</a>
          <a href="#methodology">Methodology</a>
        </div>
        <div
          className="status"
          title={data.asOf ? `Updated through ${exactTime(data.asOf)} UTC` : undefined}
        >
          <span
            className={selectedProtocolData.live ? "liveDot" : "previewDot"}
          />
          {loading
            ? "Connecting"
            : selectedProtocolData.live
              ? `Near real-time · ${relativeTime(data.asOf)}`
              : "Data unavailable"}
        </div>
      </nav>

      <div className="protocolStrip" aria-label="Protocol view">
        <div className="protocolTabs">
          {(["all", "mpp", "x402"] as ProtocolKey[]).map((item) => (
            <button
              key={item}
              className={protocol === item ? "active" : ""}
              onClick={() => selectProtocol(item)}
              aria-pressed={protocol === item}
            >
              {item === "all" ? "All protocols" : item.toUpperCase()}
            </button>
          ))}
        </div>
        <button className="protocolSubmit" onClick={() => setSubmissionOpen(true)}>
          Submit a service
        </button>
      </div>

      <section className="hero" id="top">
        <div className="heroCopy">
          <div className="kicker">
            <span>Stablecoin payments intelligence</span>
            <i />
            <span>{PROTOCOL_LABELS[protocol]}</span>
          </div>
          <h1>
            <span>The machine economy,</span>
            <em>made legible.</em>
          </h1>
          <div className="askDock heroAsk" id="ask-index">
            <div className="askDockLabel">
              <span className="spark">✦</span>
              <span>Ask the Index</span>
              <small>Computed from observed data</small>
            </div>
            <form onSubmit={submitQuestion}>
              <label className="srOnly" htmlFor="network-question">
                Ask a question about MPP and x402 payment activity
              </label>
              <textarea
                id="network-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={3}
              />
              <button type="submit" aria-label="Ask question" disabled={answering}>
                {answering ? "Analyzing…" : justAnswered ? "Answered ✓" : "Ask"}{" "}
                {!answering && !justAnswered && <span>↗</span>}
              </button>
            </form>
            <div className="askSuggestions" aria-label="Suggested questions">
              {QUESTIONS.map((item) => (
                <button
                  key={item}
                  onClick={() => {
                    setQuestion(item);
                    runQuestion(item);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
            {!hasAsked ? (
              <p className="askHint">
                Ask about metrics, growth, services, anomalies, cohorts, wallets, or evidence coverage.
              </p>
            ) : (
              <div
                key={answerRevision}
                className="answer answerFlash consoleAnswer"
                aria-live="polite"
                role="status"
              >
                <div className="answerHead">
                  <span>{answer.eyebrow}</span>
                  <span className={answer.limited ? "coverageLimited" : "verified"}>
                    {answer.status ?? (answer.limited
                      ? "Coverage limit disclosed"
                      : "Verified calculation")}
                  </span>
                </div>
                <div className="answerValueRow">
                  <strong>{answer.value}</strong>
                  {answer.change !== null && (
                    <span
                      className={
                        answer.change >= 0
                          ? "changePositive"
                          : "changeNegative"
                      }
                    >
                      {answer.change >= 0 ? "↑" : "↓"}{" "}
                      {Math.abs(answer.change).toFixed(1)}%
                    </span>
                  )}
                </div>
                <p className="comparison">{answer.comparison}</p>
                {answer.visualization === "cohort" && answer.cohort?.available && (
                  <CohortHeatmap matrix={answer.cohort} />
                )}
                {answer.visualization !== "none" && answerSeries.some((series) => series.buckets.length) && (
                  answer.visualization !== "cohort" &&
                  <LabeledBarChart
                    className="answerChart"
                    days={answer.days}
                    yAxisTitle={
                      answer.metric === "volume"
                        ? answer.protocol === "x402"
                          ? "x402 payment value per bucket"
                          : "MPP payment value per bucket"
                        : answer.metric === "average"
                          ? answer.protocol === "x402"
                            ? "Average x402 payment per bucket"
                            : "Average MPP payment per bucket"
                          : answer.metric === "buyers"
                            ? "Active payer addresses per bucket"
                            : answer.metric === "servers"
                              ? "Active recipient addresses per bucket"
                              : "Observed records per bucket"
                    }
                    series={answerSeries}
                  />
                )}
                <div className="formula">
                  <span>Calculation</span>
                  <code>{answer.formula}</code>
                </div>
                <p className="explanation">{answer.explanation}</p>
                {answer.source && (
                  <p className="answerSource">
                    Source: {answer.source}
                    {answer.cohort?.completeThrough
                      ? ` · verified identity coverage through ${answer.cohort.completeThrough}.`
                      : " · calculated from the latest direct-evidence snapshot."}
                  </p>
                )}
                {!answer.limited && (
                  <div className="answerShare" aria-label="Share this answer">
                    <span>Share this insight</span>
                    <button type="button" onClick={copyAnswerLink}>Copy live link</button>
                    <button type="button" onClick={() => shareAnswer("x")}>X</button>
                    <button type="button" onClick={() => shareAnswer("linkedin")}>LinkedIn</button>
                    <button type="button" onClick={downloadAnswerCard}>Download card</button>
                    {shareStatus && <small role="status">{shareStatus}</small>}
                  </div>
                )}
                {answerError && <p className="answerError">{answerError}</p>}
              </div>
            )}
          </div>
        </div>

        <aside className="analystConsole" aria-label="Live market overview">
          <div className="consoleHeading">
            <div>
              <span className="consoleEyebrow">Live market overview</span>
              <strong>At a glance</strong>
            </div>
            <div className="periodControl compactPeriod" aria-label="Time period">
              {PERIODS.map((item) => (
                <button
                  key={item.days}
                  className={period === item.days ? "active" : ""}
                  disabled={item.disabled || (item.days === 0 && !allTimeAvailable)}
                  title={item.days === 0 && !allTimeAvailable ? allTimeUnavailableTitle : undefined}
                  onClick={() => {
                    if (item.disabled) return;
                    setPeriod(item.days);
                    setServicePage(1);
                  }}
                  aria-pressed={period === item.days}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="heroMetrics">
            <article>
              <InfoTerm
                label="Transactions"
                definition={`${selectedProtocolData.measurementLabel} in the exact rolling time window.`}
                formula="Count of records matching the published protocol-specific direct-source method."
                example="The combined view adds record counts while preserving the distinct MPP and x402 definitions."
              />
              <strong>
                {selectedProtocolData.live
                  ? compact(selected.stats.totalTransactions)
                  : "—"}
              </strong>
              <small>
                {selectedProtocolData.live
                  ? `${compact(selected.stats.totalTransactions / selectedPeriodDays)} per day`
                  : "Connecting to index"}
              </small>
            </article>
            <article>
              <InfoTerm
                label={selectedProtocolData.volumeLabel}
                definition={
                  protocol === "all"
                    ? "MPP and x402 payment values are shown separately because they cover different protocols and networks."
                    : protocol === "mpp"
                      ? "The value of current-version MPP charges and settled sessions observed directly on Tempo."
                      : "Payer-originated USDC payment value involving the maintained x402 facilitator set on Base. Receive-and-forward chains count once and resolve to the final recipient."
                }
                formula={
                  protocol === "all"
                    ? "Shown separately by protocol; no combined dollar total."
                    : "Sum of the directly observed values in the exact rolling window."
                }
                example={
                  protocol === "all"
                    ? `MPP ${usd(mppSelected.totalVolume)} · x402 ${usd(x402Selected.totalVolume)}`
                    : `${usd(selected.stats.totalVolume)} observed across the selected window.`
                }
              />
              <strong>
                {selectedProtocolData.live
                  ? selectedProtocolData.volumeComparable
                    ? compactUsd(selected.stats.totalVolume)
                    : "Not combined"
                  : "—"}
              </strong>
              <small>
                {selectedProtocolData.live
                  ? selectedProtocolData.volumeComparable
                    ? `${usd(average, true)} average per observed record`
                    : "Different measurement units"
                  : "Connecting to index"}
              </small>
            </article>
            <article>
              <InfoTerm
                label="Active payer addresses"
                definition={
                  protocol === "all"
                    ? "The sum of distinct payer addresses reported by each protocol. The same payer may appear in both protocols."
                    : "Distinct network-normalized payer addresses that completed at least one payment in the selected protocol and window."
                }
                formula={
                  protocol === "all"
                    ? "MPP active payer addresses + x402 active payer addresses."
                    : "Distinct successful-payment payer addresses."
                }
                example="One actor using two wallets may be counted twice; several actors can also share one wallet."
              />
              <strong>
                {selectedProtocolData.live
                  ? compact(selected.stats.uniqueSenders)
                  : "—"}
              </strong>
              <small>
                {selectedProtocolData.live
                  ? protocol === "all"
                    ? "Protocol-level sum"
                    : "Distinct payer addresses"
                  : "Connecting to index"}
              </small>
            </article>
            <article>
              <InfoTerm
                label="Active recipient addresses"
                definition="Distinct network-normalized recipient addresses that received at least one observed payment in the selected window."
                formula="Count of distinct directly observed recipient identifiers in the selected window."
                example="One service can use several recipient addresses, so this is not a count of servers or companies."
              />
              <strong>
                {selectedProtocolData.live
                  ? compact(selected.stats.uniqueRecipients)
                  : "—"}
              </strong>
              <small>{protocol === "all" ? "Protocol-level sum" : "Active recipients"}</small>
            </article>
          </div>

          <div className="heroChart">
            <div className="chartHeading">
              <div>
                <InfoTerm
                  label="Protocol activity"
                  definition="Directly observed protocol-attributed MPP payments and facilitator-associated x402 settlements, shown separately."
                  formula="Count of qualifying records per time bucket under each protocol's published method."
                  example="Taller bars indicate more qualifying records during that bucket, not higher dollar value."
                />
                <small>{period === 0 ? `Available indexed history since ${coverageStart(selected.buckets)}` : period === 1 ? "Past 24 hours" : `Past ${period} days`} · source-native buckets</small>
              </div>
              <div className="chartLegend" aria-label="Chart legend">
                {(protocol === "all" || protocol === "mpp") && <span><i className="legendMpp" />MPP</span>}
                {(protocol === "all" || protocol === "x402") && <span><i className="legendX402" />x402</span>}
              </div>
            </div>
            <LabeledBarChart
              days={period}
              yAxisTitle="Observed records per bucket"
              series={(protocol === "all" ? ["mpp", "x402"] : [protocol]).map((item) => ({
                key: item,
                label: PROTOCOL_LABELS[item as ProtocolKey],
                className: item === "mpp" ? "seriesMpp" : "seriesX402",
                buckets: data.protocols[item as ProtocolKey].periods[selectedKey].buckets,
                metric: "transactions" as const,
              }))}
            />
          </div>

        </aside>
      </section>

      <section className="indexDefinition" id="coverage">
        <div className="definitionLead">
          <span className="sectionNumber">What this index measures</span>
          <h2>Machine-payment activity, measured clearly and honestly.</h2>
        </div>
        <div className="definitionBody">
          <p className="definitionIntro">
            The Agentic Payments Index brings MPP and x402 stablecoin activity into
            one evidence-led view. It shows what the chain data proves—and clearly
            labels what it cannot prove about the person, application, or agent
            behind a wallet.
          </p>
          <div className="definitionStates">
            <article>
              <span>01 / Observed</span>
              <strong>Protocol activity</strong>
              <p>
                Transactions, value, payer and recipient identifiers, and timestamps
                reconstructed from Tempo and Base. Named service origins remain a
                separate directory layer.
              </p>
            </article>
            <article>
              <span>02 / Not inferred</span>
              <strong>Agent identity</strong>
              <p>
                Payer counts are addresses—not verified autonomous agents.
                Cross-protocol identities may overlap and are not deduplicated.
              </p>
            </article>
            <article>
              <span>03 / Excluded</span>
              <strong>Private rails</strong>
              <p>
                Card and bank settlement, private ledgers, direct wallet transfers,
                and unindexed networks remain outside this first release.
              </p>
            </article>
          </div>
          <p className="definitionDisclosure">{selectedProtocolData.disclosure}</p>
        </div>
      </section>

      <section className="section" id="pulse">
        <div className="sectionHeading">
          <div>
            <span className="sectionNumber">01 / Network pulse</span>
            <h2>{PROTOCOL_LABELS[protocol]} at a glance</h2>
          </div>
          <div className="periodControl" aria-label="Time period">
            {PERIODS.map((item) => (
              <button
                key={item.days}
                className={period === item.days ? "active" : ""}
                disabled={item.disabled || (item.days === 0 && !allTimeAvailable)}
                title={item.days === 0 && !allTimeAvailable ? allTimeUnavailableTitle : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  setPeriod(item.days);
                  setServicePage(1);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="metrics">
          <MetricCard
            label="Transactions"
            value={compact(selected.stats.totalTransactions)}
            note={`${compact(selected.stats.totalTransactions / selectedPeriodDays)} / day`}
            definition={`${selectedProtocolData.measurementLabel} in the exact rolling time window.`}
            formula="Count of records that satisfy the protocol-specific direct-source method."
            example="MPP and x402 use different attribution rules; the combined view sums their record counts but preserves those definitions."
          />
          <MetricCard
            label={selectedProtocolData.volumeLabel}
            value={
              selectedProtocolData.volumeComparable
                ? compactUsd(selected.stats.totalVolume)
                : "Not combined"
            }
            note={
              selectedProtocolData.volumeComparable
                ? `${usd(average, true)} average per record`
                : "MPP and x402 shown separately"
            }
            definition={
              protocol === "all"
                ? "MPP and x402 payment values are shown separately because their protocol and network coverage differs."
                : protocol === "mpp"
                  ? "Value of current-version MPP charges and settled sessions observed directly on Tempo."
                  : "Payer-originated USDC payment value involving the maintained x402 facilitator set on Base; receive-and-forward chains count once."
            }
            formula={
              protocol === "all"
                ? "No combined value is calculated."
                : "Sum of directly observed value in the exact rolling window."
            }
            example={
              protocol === "all"
                ? `MPP ${usd(mppSelected.totalVolume)} · x402 ${usd(x402Selected.totalVolume)}`
                : `Observed value: ${usd(selected.stats.totalVolume)}.`
            }
          />
          <MetricCard
            label="Active payer addresses"
            value={compact(selected.stats.uniqueSenders)}
            note={protocol === "all" ? "Protocol-level sum" : "Unique senders"}
            definition={
              protocol === "all"
                ? "The sum of distinct payer addresses reported by MPP and x402. Cross-protocol identity is not deduplicated."
                : "Distinct network-normalized payer addresses that completed at least one payment in this protocol and window."
            }
            formula={
              protocol === "all"
                ? "MPP active payer addresses + x402 active payer addresses."
                : "Distinct successful-payment payer addresses."
            }
            example="One actor using two wallets can appear twice; several actors can also share one wallet."
          />
          <MetricCard
            label="Active recipient addresses"
            value={compact(selected.stats.uniqueRecipients)}
            note={
              protocol === "all"
                ? "Protocol-level sum; not companies"
                : "Distinct active recipients"
            }
            definition="Distinct network-normalized recipient addresses that received at least one observed payment in the selected window. These are not servers, companies, or necessarily distinct services."
            formula="Distinct active recipient addresses reported by the selected protocol indexes."
            example="Several wallet addresses may belong to the same underlying service."
          />
        </div>

        {protocol === "all" && (
          <div className="protocolComparison">
            <div className="comparisonHeading">
              <div>
                <InfoTerm
                  label="Protocol share"
                  definition="Each protocol's portion of combined observed record counts for the same time window. Dollar values are not compared because their measurement units differ."
                  formula="Protocol record count ÷ combined MPP and x402 record count × 100."
                  example="If MPP has 40 qualifying records and x402 has 60, their activity shares are 40% and 60%."
                />
                <strong>MPP vs x402</strong>
              </div>
              <small>Same {period === 0 ? "available-history" : period === 1 ? "24-hour" : `${period}-day`} window</small>
            </div>
            <div className="shareRows">
              <div className="shareRow">
                <span>Transactions</span>
                <div className="shareTrack" aria-hidden="true">
                  <i
                    className="shareMpp"
                    style={{
                      width: `${combinedTransactions ? (mppSelected.totalTransactions / combinedTransactions) * 100 : 0}%`,
                    }}
                  />
                  <i
                    className="shareX402"
                    style={{
                      width: `${combinedTransactions ? (x402Selected.totalTransactions / combinedTransactions) * 100 : 0}%`,
                    }}
                  />
                </div>
                <b>
                  MPP {compact(mppSelected.totalTransactions)} · x402{" "}
                  {compact(x402Selected.totalTransactions)}
                </b>
              </div>
              <div className="shareRow valueSeparationRow">
                <span>Value measurements</span>
                <div className="separateValues" aria-label="Protocol value measurements shown separately">
                  <i className="legendMpp" />
                  <b>MPP payment value {usd(mppSelected.totalVolume)}</b>
                  <i className="legendX402" />
                  <b>x402 payment value {usd(x402Selected.totalVolume)}</b>
                </div>
                <small>Not combined</small>
              </div>
            </div>
          </div>
        )}

        <div className="activityGrid">
          <article className="activityPanel">
            <div className="panelHeading">
              <div>
                <InfoTerm
                  label="Average daily transactions"
                  definition="The average number of qualifying direct-source records observed per day in the selected time window."
                  formula="Total observed records ÷ number of days."
                  example={`${compact(selected.stats.totalTransactions)} ÷ ${Math.round(selectedPeriodDays)} days = ${compact(Math.round(selected.stats.totalTransactions / selectedPeriodDays))} transactions per day.`}
                />
                <strong>
                  {compact(Math.round(selected.stats.totalTransactions / selectedPeriodDays))}
                  <small> / day</small>
                </strong>
              </div>
              <div className="legend">
                <span><i className="legendMint" /> Transactions</span>
              </div>
            </div>
            <LabeledBarChart
              className="activityChart"
              days={period}
              yAxisTitle="Observed records per bucket"
              series={[
                {
                  key: protocol,
                  label: PROTOCOL_LABELS[protocol],
                  className:
                    protocol === "mpp"
                      ? "seriesMpp"
                      : protocol === "x402"
                        ? "seriesX402"
                        : "seriesAll",
                  buckets: selected.buckets,
                  metric: "transactions",
                },
              ]}
            />
          </article>

          <article className="signalPanel">
            {protocol === "all" ? (
              <>
                <span className="signalLabel">
                  <InfoTerm
                    label="Value measurements"
                    definition="MPP and x402 payment values are reconstructed independently and kept separate because their coverage differs."
                    formula="Values are shown separately; no combined total or average is calculated."
                    example={`MPP ${usd(mppSelected.totalVolume)} · x402 ${usd(x402Selected.totalVolume)}`}
                  />
                </span>
                <strong>Not combined</strong>
                <p>Comparable activity counts; distinct value definitions.</p>
                <div className="signalRule" />
                <dl>
                  <div>
                    <dt>MPP payment value</dt>
                    <dd>{usd(mppSelected.totalVolume)}</dd>
                  </div>
                  <div>
                    <dt>x402 payment value</dt>
                    <dd>{usd(x402Selected.totalVolume)}</dd>
                  </div>
                  <div>
                    <dt>Data window</dt>
                    <dd>{periodLabel(period)}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <>
                <span className="signalLabel">
                  <InfoTerm
                    label={protocol === "mpp" ? "Average MPP payment size" : "Average x402 payment size"}
                    definition={
                      protocol === "mpp"
                        ? "The mean identified MPP payment value in the selected window."
                        : "The mean payer-originated USDC value per reconstructed x402 payment. Receive-and-forward chains count once."
                    }
                    formula="Observed value ÷ qualifying records."
                    example={`${usd(selected.stats.totalVolume)} ÷ ${compact(selected.stats.totalTransactions)} = ${usd(average, true)} per record.`}
                  />
                </span>
                <strong>{usd(average, true)}</strong>
                <p>{protocol === "mpp" ? "Average identified MPP payment." : "Average reconstructed x402 payment."}</p>
                <div className="signalRule" />
                <dl>
                  <div>
                    <dt>{selectedProtocolData.volumeLabel}</dt>
                    <dd>{usd(selected.stats.totalVolume)}</dd>
                  </div>
                  <div>
                    <dt>Observed records</dt>
                    <dd>{compact(selected.stats.totalTransactions)}</dd>
                  </div>
                  <div>
                    <dt>Data window</dt>
                    <dd>{periodLabel(period)}</dd>
                  </div>
                </dl>
              </>
            )}
          </article>
        </div>
      </section>

      <section className="section evidenceSection" id="evidence">
        <div className="evidenceLead">
          <span className="sectionNumber">02 / Evidence state</span>
          <h2>Raw activity is not the same as real adoption.</h2>
          <p>
            Every view separates observed payment events, active identities,
            named directory records, and quality adjustments. We publish the
            defensible number—and the evidence boundary that comes with it.
          </p>
          <div className="periodControl evidencePeriod" aria-label="Evidence time period">
            {PERIODS.map((item) => (
              <button
                key={item.days}
                className={period === item.days ? "active" : ""}
                disabled={item.disabled || (item.days === 0 && !allTimeAvailable)}
                title={item.days === 0 && !allTimeAvailable ? allTimeUnavailableTitle : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  setPeriod(item.days);
                  setServicePage(1);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="evidenceGrid">
          <article>
            <span className="evidenceState liveEvidence">Directly observed</span>
            <small>Qualifying records</small>
            <strong>{compact(selected.stats.totalTransactions)}</strong>
            <p>
              Records matching the published MPP or x402 direct-source method in
              the exact rolling window.
            </p>
          </article>
          <article>
            <span className="evidenceState resolvedEvidence">Directly observed</span>
            <small>Active recipient addresses</small>
            <strong>{compact(selected.stats.uniqueRecipients)}</strong>
            <p>
              Distinct recipient addresses paid in this window—not servers or companies,
              and not the named service-directory count.
            </p>
          </article>
          <aside className="qualityDisclosure">
            <span>Data quality</span>
            <p>
              These are raw observed totals. Testing, duplicate, internal, and
              unresolved activity may be included. Adjusted estimates will only
              appear after the rules, backfill, and confidence ranges are published.
            </p>
            <a href="/coverage">See coverage and known limits ↗</a>
          </aside>
        </div>
      </section>

      <section className="section servicesSection" id="services">
        <div className="sectionHeading">
          <div>
            <span className="sectionNumber">03 / Recipients</span>
            <h2>Recipients</h2>
          </div>
          <div className="servicesHeadingAside">
            <div className="periodControl" aria-label="Service directory time period">
              {PERIODS.map((item) => (
                <button
                  key={item.days}
                  className={period === item.days ? "active" : ""}
                  disabled={item.disabled || (item.days === 0 && !allTimeAvailable)}
                  title={item.days === 0 && !allTimeAvailable ? allTimeUnavailableTitle : undefined}
                  onClick={() => {
                    if (item.disabled) return;
                    setPeriod(item.days);
                    setServicePage(1);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="sectionIntro">
              Complete source-backed pagination, ranked by observed activity in
              the selected period.
            </p>
          </div>
        </div>

        <div className="directorySummary">
          <div>
            <span>Indexed service records</span>
            <strong>
              {directoryLoading && !directory.total
                ? "Connecting"
                : compact(directory.total)}
            </strong>
          </div>
          <dl>
            <div>
              <dt>MPP origins</dt>
              <dd>{compact(directory.sourceTotals.mpp)}</dd>
            </div>
            <div>
              <dt>x402 origins</dt>
              <dd>{compact(directory.sourceTotals.x402)}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>{period === 0 ? `Since ${coverageStart(selected.buckets)}` : periodLabel(period)}</dd>
            </div>
          </dl>
          <p>
            {directoryError || directory.disclosure}
          </p>
        </div>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Rank / Service</th>
                <th>
                  <button
                    className={sort === "transactions" ? "sortActive" : ""}
                    onClick={() => {
                      setSort("transactions");
                      setServicePage(1);
                    }}
                  >
                    Transactions {sort === "transactions" ? "↓" : ""}
                  </button>
                </th>
                <th>
                  <button
                    className={sort === "volume" ? "sortActive" : ""}
                    onClick={() => {
                      setSort("volume");
                      setServicePage(1);
                    }}
                  >
                    Volume {sort === "volume" ? "↓" : ""}
                  </button>
                </th>
                <th>
                  <button
                    className={sort === "buyers" ? "sortActive" : ""}
                    onClick={() => {
                      setSort("buyers");
                      setServicePage(1);
                    }}
                  >
                    Payer addresses {sort === "buyers" ? "↓" : ""}
                  </button>
                </th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {directory.items.map((service) => (
                <tr key={`${service.protocol}-${service.id}`}>
                  <td>
                    <span className="rank">
                      {String(service.rank).padStart(2, "0")}
                    </span>
                    <span className="serviceIcon">
                      {service.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="serviceCopy">
                      <a
                        href={service.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {service.name} ↗
                      </a>
                      <span className={`serviceBadge ${service.protocol}`}>
                        {service.protocol.toUpperCase()} · {service.network}
                      </span>
                      <small>{service.description}</small>
                    </span>
                  </td>
                  <td>{compact(service.stats.transactions)}</td>
                  <td>{usd(service.stats.volume)}</td>
                  <td>{compact(service.stats.buyers)}</td>
                  <td className="latest">{relativeTime(service.stats.latestTx)}</td>
                </tr>
              ))}
              {directoryLoading &&
                !directory.items.length &&
                ["ATXP", "2Captcha", "AIsa", "Exa", "Parallel"].map(
                  (name, index) => (
                    <tr className="placeholderRow" key={name}>
                      <td>
                        <span className="rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="serviceIcon">
                          {name.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="serviceCopy">
                          <b>{name}</b>
                          <small>Loading live service activity…</small>
                        </span>
                      </td>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                    </tr>
                  ),
                )}
              {!directoryLoading && directoryError && (
                <tr className="directoryErrorRow">
                  <td colSpan={5}>{directoryError}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="pagination">
          <button
            onClick={() =>
              setServicePage((current) => Math.max(1, current - 1))
            }
            disabled={servicePage <= 1 || directoryLoading}
          >
            ← Previous
          </button>
          <div className="pageNumbers" aria-label="Service directory pages">
            {paginationWindow(servicePage, directory.totalPages).map(
              (pageNumber, index, pages) => [
                index > 0 && pageNumber - pages[index - 1] > 1 ? (
                  <span key={`gap-${pageNumber}`}>…</span>
                ) : null,
                <button
                  key={pageNumber}
                  className={pageNumber === servicePage ? "active" : ""}
                  onClick={() => setServicePage(pageNumber)}
                  disabled={directoryLoading}
                  aria-current={pageNumber === servicePage ? "page" : undefined}
                >
                  {pageNumber}
                </button>,
              ],
            )}
          </div>
          <button
            onClick={() =>
              setServicePage((current) =>
                Math.min(directory.totalPages, current + 1),
              )
            }
            disabled={
              servicePage >= directory.totalPages || directoryLoading
            }
          >
            Next →
          </button>
          <span>
            Page {servicePage} of {directory.totalPages}
          </span>
        </div>
      </section>

      <section className="section identitySection" id="identity">
        <div className="identityLead">
          <div>
            <span className="sectionNumber">04 / Identity intelligence</span>
            <h2>Know what is a wallet, a service, and an agent claim.</h2>
          </div>
          <p>
            Payment rails reveal addresses and recipients. They do not automatically
            reveal a person, wallet provider, or autonomous agent. The Index keeps
            those claims separate and attaches confidence to every attribution.
          </p>
        </div>
        <div className="identityGrid">
          <article>
            <span>Address layer</span>
            <strong>Active payer + recipient addresses</strong>
            <p>Directly observed identifiers, with cross-wallet and cross-protocol duplication disclosed.</p>
          </article>
          <article>
            <span>Wallet layer</span>
            <strong>Open attribution registry</strong>
            <p>Provider, account type, and facilitator stay separate. Coverage remains unavailable until transaction-level matching is live.</p>
            <a href="/api/wallets" target="_blank">Inspect the registry ↗</a>
          </article>
          <article>
            <span>Autonomy layer</span>
            <strong>Unknown until evidenced</strong>
            <p>Protocol use alone is not proof of autonomous execution. Signed attestations can upgrade a payment from Unknown.</p>
          </article>
          <article className="identityAction">
            <span>Service layer</span>
            <strong>Verify your service</strong>
            <p>Prove domain control and protocol-endpoint reachability before a submitted service can become active.</p>
            <button onClick={() => setSubmissionOpen(true)}>Submit a service ↗</button>
          </article>
        </div>
      </section>

      <section className="methodology" id="methodology">
        <div>
          <span className="sectionNumber">05 / Methodology</span>
          <h2>Evidence you can audit.</h2>
        </div>
        <div className="methodGrid">
          <article>
            <span>01</span>
            <h3>Observe</h3>
            <p>
              Current beta totals are reconstructed independently from Base and Tempo
              chain evidence. MPPScan and x402scan are used only as reconciliation
              references.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Resolve</h3>
            <p>
              Raw recipients remain distinct from named service origins.
              Complete pagination and source totals make that coverage visible.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Qualify</h3>
            <p>
              Raw, resolved, and quality-adjusted states are labelled
              separately. No organic-activity claim is made before the
              confidence model is published.
            </p>
          </article>
          <article>
            <span>04</span>
            <h3>Explain</h3>
            <p>
              Every computed answer carries its metric, time window, formula,
              source, and the limitation that changes how it should be read.
            </p>
          </article>
        </div>
      </section>

      <footer>
        <a className="brand footerBrand" href="#top">
          <span className="brandMark" aria-hidden="true">
            <i />
            <i />
          </span>
          <span>THE AGENTIC PAYMENTS INDEX</span>
        </a>
        <p>
          Current beta data is reconstructed independently from Base and Tempo chain
          evidence. Public explorers such as{" "}
          <a href="https://mppscan.com" target="_blank" rel="noreferrer">
            MPPScan
          </a>{" "}
          and{" "}
          <a href="https://www.x402scan.com" target="_blank" rel="noreferrer">
            x402scan
          </a>
          {" "}are reconciliation references—not data feeds. Not affiliated with either index.
          {" "}<a href="/about">About</a> · <a href="/coverage">Coverage</a> ·{" "}
          <a href="https://github.com/NITYAio/agentic-payments-index" target="_blank" rel="noreferrer">Contribute</a>
        </p>
        <span>
          Updated through {data.asOf ? `${exactTime(data.asOf)} UTC` : "when data connects"}
        </span>
      </footer>
      {submissionOpen && (
        <div
          className="modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSubmissionOpen(false);
          }}
        >
          <section className="submissionModal" role="dialog" aria-modal="true" aria-labelledby="submission-title">
            <div className="submissionHead">
              <div>
                <span className="sectionNumber">Service registry</span>
                <h2 id="submission-title">Submit a service</h2>
              </div>
              <button className="modalClose" onClick={() => setSubmissionOpen(false)} aria-label="Close submission dialog">×</button>
            </div>
            {!submissionResult ? (
              <form className="submissionForm" onSubmit={submitService}>
                <label>
                  <span>Service name</span>
                  <input required value={submissionForm.serviceName} onChange={(event) => setSubmissionForm({ ...submissionForm, serviceName: event.target.value })} />
                </label>
                <label>
                  <span>Canonical HTTPS URL</span>
                  <input required type="url" placeholder="https://example.com" value={submissionForm.canonicalUrl} onChange={(event) => setSubmissionForm({ ...submissionForm, canonicalUrl: event.target.value })} />
                </label>
                <div className="submissionFormRow">
                  <label>
                    <span>Protocol</span>
                    <select value={submissionForm.protocol} onChange={(event) => setSubmissionForm({ ...submissionForm, protocol: event.target.value })}>
                      <option value="mpp">MPP</option>
                      <option value="x402">x402</option>
                      <option value="both">MPP + x402</option>
                    </select>
                  </label>
                  <label>
                    <span>Network</span>
                    <input required value={submissionForm.network} onChange={(event) => setSubmissionForm({ ...submissionForm, network: event.target.value })} />
                  </label>
                </div>
                <label>
                  <span>Live protocol endpoint</span>
                  <input required type="url" placeholder="https://api.example.com/pay" value={submissionForm.protocolEndpoint} onChange={(event) => setSubmissionForm({ ...submissionForm, protocolEndpoint: event.target.value })} />
                </label>
                <label>
                  <span>Contact email (kept private)</span>
                  <input required type="email" value={submissionForm.contactEmail} onChange={(event) => setSubmissionForm({ ...submissionForm, contactEmail: event.target.value })} />
                </label>
                <p className="submissionNote">Submitting creates a domain-control challenge. It does not automatically add or endorse the service.</p>
                {submissionError && <p className="submissionError">{submissionError}</p>}
                <button className="submissionPrimary" type="submit" disabled={submissionLoading}>
                  {submissionLoading ? "Creating challenge…" : "Create verification challenge"}
                </button>
              </form>
            ) : (
              <div className="verificationFlow">
                <span className="verificationStatus">{submissionResult.status}</span>
                <h3>Publish this verification file</h3>
                <p>Host the following JSON at <code>{submissionResult.verification.url}</code>, then run the check.</p>
                <pre>{JSON.stringify(submissionResult.verification.body, null, 2)}</pre>
                <p className="submissionNote">{submissionResult.verificationMessage ?? submissionResult.verification.note}</p>
                {submissionError && <p className="submissionError">{submissionError}</p>}
                <div className="verificationActions">
                  <button className="submissionPrimary" onClick={verifyService} disabled={submissionLoading || submissionResult.status === "verified"}>
                    {submissionLoading ? "Checking…" : submissionResult.status === "verified" ? "Verified ✓" : "Verify now"}
                  </button>
                  <button onClick={() => {
                    setSubmissionResult(null);
                    setSubmissionError("");
                  }}>Start another</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      <ViewToggle machineMode={false} onChange={setMachineMode} />
    </main>
  );
}
