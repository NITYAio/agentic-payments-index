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
};

type ProtocolKey = "all" | "mpp" | "x402";

type ProtocolData = {
  source: string;
  live: boolean;
  disclosure: string;
  periods: Record<"1" | "7" | "30", Period>;
  services: Record<"1" | "7" | "30", Service[]>;
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

type Answer = {
  eyebrow: string;
  value: string;
  change: number | null;
  comparison: string;
  formula: string;
  explanation: string;
  days: 1 | 7 | 30;
  metric: "average" | "volume" | "transactions" | "buyers" | "servers";
  protocol: ProtocolKey;
  limited?: boolean;
};

const PERIODS = [
  { days: 1 as const, label: "24h" },
  { days: 7 as const, label: "7d" },
  { days: 30 as const, label: "30d" },
];

const QUESTIONS = [
  "Compare MPP and x402 over 7 days",
  "Average x402 payment size in 24h",
  "Which services led today?",
];

const EMPTY_PROTOCOL: ProtocolData = {
  source: "Waiting for live data",
  live: false,
  disclosure: "No placeholder values are shown while live data loads.",
  periods: {
    "1": {
      stats: { totalTransactions: 0, totalVolume: 0, uniqueSenders: 0, uniqueRecipients: 0 },
      buckets: [],
    },
    "7": {
      stats: { totalTransactions: 0, totalVolume: 0, uniqueSenders: 0, uniqueRecipients: 0 },
      buckets: [],
    },
    "30": {
      stats: { totalTransactions: 0, totalVolume: 0, uniqueSenders: 0, uniqueRecipients: 0 },
      buckets: [],
    },
  },
  services: { "1": [], "7": [], "30": [] },
};

const FALLBACK: ExplorerData = {
  source: "Connecting to public indexes",
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

function percentageDelta(value: number, baseline: number) {
  if (!baseline) return null;
  return ((value - baseline) / baseline) * 100;
}

function getTimeframes(question: string): {
  primary: 1 | 7 | 30;
  comparison: 1 | 7 | 30 | null;
} {
  const text = question.toLowerCase();
  const occurrences: Array<{ days: 1 | 7 | 30; index: number }> = [];
  const patterns: Array<{ days: 1 | 7 | 30; pattern: RegExp }> = [
    {
      days: 1,
      pattern: /\b(?:24\s*(?:hours?|h)|today|1\s*day|one\s*day)\b/g,
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
  const protocolLabel = PROTOCOL_LABELS[protocol];
  const { primary: days, comparison: comparisonDays } = getTimeframes(text);
  const current =
    protocolData.periods[String(days) as "1" | "7" | "30"].stats;
  const baseline = comparisonDays
    ? protocolData.periods[String(comparisonDays) as "1" | "7" | "30"].stats
    : null;
  const periodLabel = days === 1 ? "past 24 hours" : `past ${days} days`;
  const comparisonLabel =
    comparisonDays === 1
      ? "the 24-hour period"
      : comparisonDays
        ? `the aggregate ${comparisonDays}-day period`
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

  if (
    protocol === "all" &&
    /\bmpp\b/.test(text) &&
    (/\bx402\b/.test(text) || /\b402\b/.test(text)) &&
    (text.includes("compare") ||
      text.includes("versus") ||
      text.includes(" vs ") ||
      text.includes("share"))
  ) {
    const mpp = data.protocols.mpp.periods[String(days) as "1" | "7" | "30"].stats;
    const x402 = data.protocols.x402.periods[String(days) as "1" | "7" | "30"].stats;
    const compareVolume =
      text.includes("volume") ||
      text.includes("usd") ||
      text.includes("dollar") ||
      text.includes("spend");
    const mppValue = compareVolume ? mpp.totalVolume : mpp.totalTransactions;
    const x402Value = compareVolume ? x402.totalVolume : x402.totalTransactions;
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
        "Both protocols use the same date window. This comparison reflects their respective public indexes and documented coverage.",
      days,
      metric: compareVolume ? "volume" : "transactions",
      protocol,
    };
  }

  if (
    (text.includes("average") || text.includes("avg") || text.includes("size")) &&
    (text.includes("transaction") || text.includes("payment"))
  ) {
    const value = current.totalVolume / current.totalTransactions;
    const benchmark = baseline
      ? baseline.totalVolume / baseline.totalTransactions
      : null;
    return {
      eyebrow: `Average payment · ${periodLabel}`,
      value: usd(value, true),
      change: benchmark === null ? null : percentageDelta(value, benchmark),
      comparison: comparisonLabel
        ? `vs the average across ${comparisonLabel}`
        : "aggregate average for the selected period",
      formula: `${usd(current.totalVolume)} ÷ ${compact(current.totalTransactions)} transactions`,
      explanation:
        `This is observed ${protocolLabel} USD payment volume divided by successful transactions. It measures payment size—not network fees or unrelated token transfers.`,
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
      eyebrow: `Unique paying agents · ${periodLabel}`,
      value: compact(current.uniqueSenders),
      change: baseline
        ? percentageDelta(current.uniqueSenders, baseline.uniqueSenders)
        : null,
      comparison: comparisonLabel
        ? `vs unique agents seen across ${comparisonLabel}`
        : "unique agents in the selected period",
      formula: `${compact(current.uniqueSenders)} distinct paying addresses`,
      explanation:
        "Each sender is counted once in the selected period, even if it made many payments.",
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
      protocolData.services[String(days) as "1" | "7" | "30"] ??
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
        ? `vs recipient identities seen across ${comparisonLabel}`
        : "recipient identities in the selected period",
      formula: `${compact(current.uniqueRecipients)} distinct payment recipients`,
      explanation:
        protocol === "all"
          ? "This is the sum of recipient identities reported by both protocol indexes. It is not a count of resolved services or companies, and a recipient active on both may be counted twice."
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
    const daily = current.totalVolume / days;
    const baselineDaily =
      baseline && comparisonDays
        ? baseline.totalVolume / comparisonDays
        : null;
    return {
      eyebrow: `Payment volume · ${periodLabel}`,
      value: usd(current.totalVolume),
      change:
        baselineDaily === null ? null : percentageDelta(daily, baselineDaily),
      comparison: comparisonDays
        ? `daily run-rate vs the ${comparisonDays}-day daily average`
        : "total observed volume in the selected period",
      formula: `${compact(current.totalTransactions)} payments settled in the period`,
      explanation:
        `Volume is the total observed USD value of successful ${protocolLabel} payments in the selected period.`,
      days,
      metric: "volume",
      protocol,
    };
  }

  const daily = current.totalTransactions / days;
  const baselineDaily =
    baseline && comparisonDays
      ? baseline.totalTransactions / comparisonDays
      : null;
  return {
    eyebrow: `Successful transactions · ${periodLabel}`,
    value: compact(current.totalTransactions),
    change:
      baselineDaily === null ? null : percentageDelta(daily, baselineDaily),
    comparison: comparisonDays
      ? `daily run-rate vs the ${comparisonDays}-day daily average`
      : "total successful transactions in the selected period",
    formula: `${compact(Math.round(daily))} transactions per day`,
    explanation:
      `This counts observed successful ${protocolLabel} payments across indexed services.`,
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

function chartDate(value: string, days: 1 | 7 | 30) {
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
  showTimezone = false,
}: {
  series: ChartSeries[];
  days: 1 | 7 | 30;
  yAxisTitle: string;
  className?: string;
  showTimezone?: boolean;
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
      aria-label={`${yAxisTitle} over the selected ${days === 1 ? "24 hours" : `${days} days`}`}
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
        {showTimezone && <span>All timestamps UTC</span>}
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
  const [period, setPeriod] = useState<1 | 7 | 30>(30);
  const [question, setQuestion] = useState(
    "Compare MPP and x402 transaction volume over the last 7 days.",
  );
  const [submittedQuestion, setSubmittedQuestion] = useState(question);
  const [hasAsked, setHasAsked] = useState(false);
  const [answerRevision, setAnswerRevision] = useState(0);
  const [justAnswered, setJustAnswered] = useState(false);
  const [sort, setSort] = useState<"transactions" | "volume" | "buyers">(
    "transactions",
  );
  const [directory, setDirectory] =
    useState<DirectoryData>(EMPTY_DIRECTORY);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState("");
  const [servicePage, setServicePage] = useState(1);
  const [machineMode, setMachineMode] = useState(false);

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

  const selectedKey = String(period) as "1" | "7" | "30";
  const selectedProtocolData = data.protocols[protocol];
  const selected = selectedProtocolData.periods[selectedKey];
  const answer = useMemo(
    () => answerQuestion(data, submittedQuestion, protocol),
    [data, submittedQuestion, protocol],
  );
  const answerBuckets =
    data.protocols[answer.protocol].periods[
      String(answer.days) as "1" | "7" | "30"
    ].buckets;
  const average = selected.stats.totalTransactions
    ? selected.stats.totalVolume / selected.stats.totalTransactions
    : 0;
  const mppSelected = data.protocols.mpp.periods[selectedKey].stats;
  const x402Selected = data.protocols.x402.periods[selectedKey].stats;
  const combinedTransactions =
    mppSelected.totalTransactions + x402Selected.totalTransactions;
  const combinedVolume = mppSelected.totalVolume + x402Selected.totalVolume;

  function runQuestion(nextQuestion: string) {
    const trimmed = nextQuestion.trim();
    if (!trimmed) return;
    setSubmittedQuestion(trimmed);
    setProtocol(protocolForQuestion(trimmed, protocol));
    setHasAsked(true);
    setAnswerRevision((revision) => revision + 1);
    setJustAnswered(true);
    window.setTimeout(() => setJustAnswered(false), 1400);
  }

  function submitQuestion(event: FormEvent) {
    event.preventDefault();
    runQuestion(question);
  }

  if (machineMode) {
    const machinePayload = {
      index: "the-agentic-payments-index",
      schemaVersion: "0.2.0",
      asOf: data.asOf || null,
      selectedView: {
        protocol,
        windowDays: period,
        stats: selected.stats,
      },
      coverage: {
        indexedServiceRecords: directory.total,
        mppResolvedOrigins: directory.sourceTotals.mpp,
        x402BazaarOrigins: directory.sourceTotals.x402,
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
      },
    };

    return (
      <main className="machineShell">
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
        <section className="machineSchema">
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
            <p>Unadjusted metrics are labelled until confidence rules ship.</p>
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
            <small>Observed MPP + x402 activity</small>
          </span>
        </a>
        <div className="navLinks">
          <a href="#pulse">Network</a>
          <a href="#services">Services</a>
          <a href="#evidence">Evidence</a>
          <a href="#methodology">Methodology</a>
        </div>
        <div className="status">
          <span
            className={selectedProtocolData.live ? "liveDot" : "previewDot"}
          />
          {loading
            ? "Connecting"
            : selectedProtocolData.live
              ? "Live indexes"
              : "Data unavailable"}
        </div>
      </nav>

      <div className="protocolStrip" aria-label="Protocol view">
        <div className="protocolTabs">
          {(["all", "mpp", "x402"] as ProtocolKey[]).map((item) => (
            <button
              key={item}
              className={protocol === item ? "active" : ""}
              onClick={() => {
                setProtocol(item);
                setServicePage(1);
              }}
              aria-pressed={protocol === item}
            >
              {item === "all" ? "All protocols" : item.toUpperCase()}
            </button>
          ))}
        </div>
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
          <div className="askDock heroAsk">
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
              <button type="submit" aria-label="Ask question">
                {justAnswered ? "Answered ✓" : "Ask"}{" "}
                {!justAnswered && <span>↗</span>}
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
                Ask about a protocol, metric, comparison, or time period.
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
                    {answer.limited
                      ? "Coverage limit disclosed"
                      : "Verified calculation"}
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
                <LabeledBarChart
                  className="answerChart"
                  days={answer.days}
                  yAxisTitle={
                    answer.metric === "volume"
                      ? "USD volume per bucket"
                      : answer.metric === "average"
                        ? "Average USD payment per bucket"
                        : answer.metric === "buyers"
                          ? "Buyer identifiers per bucket"
                          : answer.metric === "servers"
                            ? "Recipient identifiers per bucket"
                            : "Successful transactions per bucket"
                  }
                  series={[
                    {
                      key: answer.protocol,
                      label: PROTOCOL_LABELS[answer.protocol],
                      className:
                        answer.protocol === "mpp"
                          ? "seriesMpp"
                          : answer.protocol === "x402"
                            ? "seriesX402"
                            : "seriesAll",
                      buckets: answerBuckets,
                      metric: answer.metric,
                    },
                  ]}
                />
                <div className="formula">
                  <span>Calculation</span>
                  <code>{answer.formula}</code>
                </div>
                <p className="explanation">{answer.explanation}</p>
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
                  onClick={() => {
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
                definition="Successful protocol-indexed payment events observed during the selected time window."
                formula="Count of successful payment records."
                example="A 30-day total of 13.2M means 13.2M successful payment events were indexed."
              />
              <strong>
                {selectedProtocolData.live
                  ? compact(selected.stats.totalTransactions)
                  : "—"}
              </strong>
              <small>
                {selectedProtocolData.live
                  ? `${compact(selected.stats.totalTransactions / period)} per day`
                  : "Connecting to index"}
              </small>
            </article>
            <article>
              <InfoTerm
                label="USD volume"
                definition="The total stablecoin settlement value recorded during the selected window, expressed in US dollars."
                formula="Sum of the USD value of observed successful payments."
                example={`${usd(selected.stats.totalVolume)} observed across the selected window.`}
              />
              <strong>
                {selectedProtocolData.live
                  ? compactUsd(selected.stats.totalVolume)
                  : "—"}
              </strong>
              <small>
                {selectedProtocolData.live
                  ? `${usd(average, true)} average payment`
                  : "Connecting to index"}
              </small>
            </article>
            <article>
              <InfoTerm
                label="Buyer identifiers"
                definition={
                  protocol === "all"
                    ? "The sum of unique sender identifiers reported by each protocol. The same buyer may appear in both protocols."
                    : "Unique sender identifiers that completed at least one payment in the selected protocol and window."
                }
                formula={
                  protocol === "all"
                    ? "MPP unique senders + x402 unique buyers."
                    : "Distinct successful-payment sender identifiers."
                }
                example="One agent using two wallets may be counted twice."
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
                    : "Unique senders"
                  : "Connecting to index"}
              </small>
            </article>
            <article>
              <InfoTerm
                label="Resolved services"
                definition="Named service-origin records available in the complete paginated directory for the selected protocol view."
                formula="Count of indexed directory records, not raw recipient addresses."
                example="One service can use several payment recipients but still resolve to one service origin."
              />
              <strong>
                {directoryLoading && !directory.total
                  ? "…"
                  : compact(directory.total)}
              </strong>
              <small>Paginated source coverage</small>
            </article>
          </div>

          <div className="heroChart">
            <div className="chartHeading">
              <div>
                <InfoTerm
                  label="Protocol activity"
                  definition="Successful payments observed in each source-native time bucket, shown separately for MPP and x402."
                  formula="Count of successful transactions per time bucket."
                  example="Taller bars indicate more payments during that bucket, not higher payment value."
                />
                <small>{period === 1 ? "Past 24 hours" : `Past ${period} days`} · source-native buckets</small>
              </div>
              <div className="chartLegend" aria-label="Chart legend">
                <span><i className="legendMpp" />MPP</span>
                <span><i className="legendX402" />x402</span>
              </div>
            </div>
            <LabeledBarChart
              days={period}
              showTimezone
              yAxisTitle="Successful transactions per bucket"
              series={[
                {
                  key: "mpp",
                  label: "MPP",
                  className: "seriesMpp",
                  buckets: data.protocols.mpp.periods[selectedKey].buckets,
                  metric: "transactions",
                },
                {
                  key: "x402",
                  label: "x402",
                  className: "seriesX402",
                  buckets: data.protocols.x402.periods[selectedKey].buckets,
                  metric: "transactions",
                },
              ]}
            />
          </div>

        </aside>
      </section>

      <section className="indexDefinition" id="coverage">
        <div className="definitionLead">
          <span className="sectionNumber">What this index measures</span>
          <h2>Open machine-payment activity, with the limits attached.</h2>
        </div>
        <div className="definitionBody">
          <p className="definitionIntro">
            The Agentic Payments Index observes stablecoin payments made through
            MPP and x402. These protocols are designed for machine commerce, but
            protocol data alone does not prove whether the payer was an autonomous
            agent, an application, or a person using software.
          </p>
          <div className="definitionStates">
            <article>
              <span>01 / Observed</span>
              <strong>Protocol activity</strong>
              <p>
                Transactions, settlement value, sender and recipient identifiers,
                timestamps, and resolved service origins exposed by the public
                indexes.
              </p>
            </article>
            <article>
              <span>02 / Not inferred</span>
              <strong>Agent identity</strong>
              <p>
                Buyer counts are identifiers—not verified autonomous agents.
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
                onClick={() => {
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
            note={`${compact(selected.stats.totalTransactions / period)} / day`}
            definition="Successful protocol-indexed payment events observed during the selected time window."
            formula="Count of successful payment records."
            example="A retry is counted only if it appears as a separate successful payment record."
          />
          <MetricCard
            label="USD volume"
            value={compactUsd(selected.stats.totalVolume)}
            note={`${usd(average, true)} avg payment`}
            definition="The sum of recorded stablecoin settlement values in the selected window, expressed in US dollars."
            formula="Sum of observed successful payment values."
            example="A $2 and a $3 payment produce $5 of USD volume."
          />
          <MetricCard
            label="Buyer identifiers"
            value={compact(selected.stats.uniqueSenders)}
            note={protocol === "all" ? "Protocol-level sum" : "Unique senders"}
            definition={
              protocol === "all"
                ? "The sum of unique sender identifiers reported by MPP and x402. Cross-protocol identity is not deduplicated."
                : "Unique sender identifiers that completed at least one payment in this protocol and window."
            }
            formula={
              protocol === "all"
                ? "MPP unique senders + x402 unique buyers."
                : "Distinct successful-payment sender identifiers."
            }
            example="One buyer using both protocols can appear twice in the combined view."
          />
          <MetricCard
            label={
              protocol === "all"
                ? "Observed recipients"
                : "Payment recipients"
            }
            value={compact(selected.stats.uniqueRecipients)}
            note={
              protocol === "all"
                ? "Protocol-level sum; not companies"
                : "Unique recipient identities"
            }
            definition="Unique payment-recipient identifiers observed in the selected window. These are not necessarily distinct companies or services."
            formula="Distinct recipient identifiers reported by the selected protocol indexes."
            example="Several wallet addresses may belong to the same underlying service."
          />
        </div>

        {protocol === "all" && (
          <div className="protocolComparison">
            <div className="comparisonHeading">
              <div>
                <InfoTerm
                  label="Protocol share"
                  definition="Each protocol's portion of the combined observed total for the same metric and time window."
                  formula="Protocol value ÷ combined MPP and x402 value × 100."
                  example="If MPP has 40 transactions and x402 has 60, their shares are 40% and 60%."
                />
                <strong>MPP vs x402</strong>
              </div>
              <small>Same {period === 1 ? "24-hour" : `${period}-day`} window</small>
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
              <div className="shareRow">
                <span>USD volume</span>
                <div className="shareTrack" aria-hidden="true">
                  <i
                    className="shareMpp"
                    style={{
                      width: `${combinedVolume ? (mppSelected.totalVolume / combinedVolume) * 100 : 0}%`,
                    }}
                  />
                  <i
                    className="shareX402"
                    style={{
                      width: `${combinedVolume ? (x402Selected.totalVolume / combinedVolume) * 100 : 0}%`,
                    }}
                  />
                </div>
                <b>
                  MPP {usd(mppSelected.totalVolume)} · x402{" "}
                  {usd(x402Selected.totalVolume)}
                </b>
              </div>
            </div>
          </div>
        )}

        <div className="activityGrid">
          <article className="activityPanel">
            <div className="panelHeading">
              <div>
                <InfoTerm
                  label="Transaction velocity"
                  definition="The average number of successful transactions observed per day in the selected time window."
                  formula="Total successful transactions ÷ number of days."
                  example={`${compact(selected.stats.totalTransactions)} ÷ ${period} = ${compact(Math.round(selected.stats.totalTransactions / period))} transactions per day.`}
                />
                <strong>
                  {compact(Math.round(selected.stats.totalTransactions / period))}
                  <small> / day</small>
                </strong>
              </div>
              <div className="legend">
                <span>
                  <i className="legendMint" /> Transactions
                </span>
                <span>
                  <i className="legendWhite" /> Relative activity
                </span>
              </div>
            </div>
            <LabeledBarChart
              className="activityChart"
              days={period}
              yAxisTitle="Successful transactions per bucket"
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
            <span className="signalLabel">
              Signal /{" "}
              <InfoTerm
                label="average payment size"
                definition="The mean USD value of successful observed payments in the selected window."
                formula="Total USD volume ÷ successful transactions."
                example={`${usd(selected.stats.totalVolume)} ÷ ${compact(selected.stats.totalTransactions)} = ${usd(average, true)} per payment.`}
              />
            </span>
            <strong>{usd(average, true)}</strong>
            <p>Average observed payment in this period.</p>
            <div className="signalRule" />
            <dl>
              <div>
                <dt>Volume</dt>
                <dd>{usd(selected.stats.totalVolume)}</dd>
              </div>
              <div>
                <dt>Transactions</dt>
                <dd>{compact(selected.stats.totalTransactions)}</dd>
              </div>
              <div>
                <dt>Data window</dt>
                <dd>{period === 1 ? "24 hours" : `${period} days`}</dd>
              </div>
            </dl>
          </article>
        </div>
      </section>

      <section className="section evidenceSection" id="evidence">
        <div className="evidenceLead">
          <span className="sectionNumber">02 / Evidence state</span>
          <h2>Raw activity is not the same as real adoption.</h2>
          <p>
            Every view states what was observed, what has been resolved to a
            service, and which quality adjustments have—or have not—been
            applied. We would rather publish a smaller defensible number than a
            larger ambiguous one.
          </p>
        </div>
        <div className="evidenceGrid">
          <article>
            <span className="evidenceState liveEvidence">Live</span>
            <small>Observed settlement layer</small>
            <strong>{compact(selected.stats.totalTransactions)}</strong>
            <p>
              Successful protocol-indexed transactions in the selected window.
            </p>
          </article>
          <article>
            <span className="evidenceState resolvedEvidence">Resolved</span>
            <small>Queryable service directory</small>
            <strong>
              {directoryLoading ? "…" : compact(directory.total)}
            </strong>
            <p>
              Protocol-level service records available across every directory
              page—not raw recipient identities.
            </p>
          </article>
          <article>
            <span className="evidenceState betaEvidence">Methodology beta</span>
            <small>Quality adjustment</small>
            <strong>Unadjusted</strong>
            <p>
              Current totals still include testing, internal activity, and
              unresolved counterparties. The classification model will publish
              confidence ranges rather than silent exclusions.
            </p>
          </article>
        </div>
      </section>

      <section className="section servicesSection" id="services">
        <div className="sectionHeading">
          <div>
            <span className="sectionNumber">03 / Service economy</span>
            <h2>Where {PROTOCOL_LABELS[protocol]} agents spend</h2>
          </div>
          <p className="sectionIntro">
            Complete source-backed pagination, ranked by observed activity in
            the selected period.
          </p>
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
              <dd>{period === 1 ? "24 hours" : `${period} days`}</dd>
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
                    Agents {sort === "buyers" ? "↓" : ""}
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

      <section className="methodology" id="methodology">
        <div>
          <span className="sectionNumber">04 / Methodology</span>
          <h2>Evidence you can audit.</h2>
        </div>
        <div className="methodGrid">
          <article>
            <span>01</span>
            <h3>Observe</h3>
            <p>
              Read-only payment aggregates and source-native time series are
              refreshed from the MPPScan and x402scan public indexes.
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
          Independent, open evidence layer using public analytics from{" "}
          <a href="https://mppscan.com" target="_blank" rel="noreferrer">
            MPPScan
          </a>{" "}
          and{" "}
          <a href="https://www.x402scan.com" target="_blank" rel="noreferrer">
            x402scan
          </a>
          . Not affiliated with either index.
        </p>
        <span>
          Updated{" "}
          {data.asOf ? `${data.asOf.slice(11, 16)} UTC` : "when data connects"}
        </span>
      </footer>
      <ViewToggle machineMode={false} onChange={setMachineMode} />
    </main>
  );
}
