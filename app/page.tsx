"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

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
  "Compare MPP and x402 transaction volume over the last 7 days.",
  "What is the average x402 payment size in the past 24 hours?",
  "Which services handled the most payments today?",
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

function Bars({
  buckets,
  metric,
  large = false,
}: {
  buckets: Bucket[];
  metric: "transactions" | "volume" | "buyers" | "servers" | "average";
  large?: boolean;
}) {
  const sampled = useMemo(() => {
    if (!buckets.length) {
      return Array.from({ length: large ? 32 : 24 }, (_, index) => ({
        value: 28 + ((index * 37) % 68),
        label: "",
      }));
    }
    const target = large ? 44 : 28;
    const step = Math.max(1, Math.ceil(buckets.length / target));
    return buckets
      .filter((_, index) => index % step === 0)
      .slice(-target)
      .map((bucket) => {
        let value = bucket.total_transactions;
        if (metric === "volume") value = bucket.total_volume;
        if (metric === "buyers") value = bucket.unique_senders;
        if (metric === "servers") value = bucket.unique_recipients;
        if (metric === "average") {
          value = bucket.total_transactions
            ? bucket.total_volume / bucket.total_transactions
            : 0;
        }
        return {
          value,
          label: new Date(bucket.bucket_start).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
          }),
        };
      });
  }, [buckets, large, metric]);

  const max = Math.max(...sampled.map((item) => item.value), 1);

  return (
    <div className={`bars ${large ? "barsLarge" : ""}`} aria-hidden="true">
      {sampled.map((item, index) => (
        <span
          key={`${item.label}-${index}`}
          title={item.label}
          style={{ height: `${Math.max(8, (item.value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  buckets,
  metric,
}: {
  label: string;
  value: string;
  note: string;
  buckets: Bucket[];
  metric: "transactions" | "volume" | "buyers" | "servers";
}) {
  return (
    <article className="metricCard">
      <div className="metricTop">
        <span>{label}</span>
        <span className="metricArrow">↗</span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
      <Bars buckets={buckets} metric={metric} />
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
    setDirectoryLoading(true);
    setDirectoryError("");
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
          <span>THE AGENTIC PAYMENTS INDEX</span>
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
        <p>
          <span>{selectedProtocolData.live ? "Observed live" : "Unavailable"}</span>
          {selectedProtocolData.disclosure}
        </p>
      </div>

      <section className="hero" id="top">
        <div className="heroCopy">
          <div className="kicker">
            <span>Stablecoin payments intelligence</span>
            <i />
            <span>{PROTOCOL_LABELS[protocol]}</span>
          </div>
          <h1>
            Agentic GDP,
            <br />
            <em>made legible.</em>
          </h1>
          <p>
            The open evidence layer for machine-native stablecoin payments.
            Explore every indexed service, compare MPP and x402, and interrogate
            the market in plain English.
          </p>
          <a className="textLink" href="#pulse">
            Explore the live network <span>↓</span>
          </a>
        </div>

        <aside className="queryPanel" aria-label="Ask the data">
          <div className="queryLabel">
            <span className="spark">✦</span>
            Ask the Index
            <span className="queryMode">Computed from live data</span>
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
            <div className="queryActions">
              <span>Try a protocol, metric, and time period</span>
              <button type="submit" aria-label="Ask question">
                {justAnswered ? "Answered ✓" : "Ask"}{" "}
                {!justAnswered && <span>↗</span>}
              </button>
            </div>
          </form>

          {!hasAsked ? (
            <div className="answer answerEmpty" aria-live="polite">
              <span className="emptySpark">✦</span>
              <div>
                <strong>Ready to query the network</strong>
                <p>
                  Press Ask to calculate the prefilled question from the latest
                  indexed activity.
                </p>
              </div>
            </div>
          ) : (
            <div
              key={answerRevision}
              className="answer answerFlash"
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
              <Bars buckets={answerBuckets} metric={answer.metric} />
              <div className="formula">
                <span>Calculation</span>
                <code>{answer.formula}</code>
              </div>
              <p className="explanation">{answer.explanation}</p>
            </div>
          )}
        </aside>
      </section>

      <div className="questionRail" aria-label="Suggested questions">
        <span>Ask next</span>
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
            buckets={selected.buckets}
            metric="transactions"
          />
          <MetricCard
            label="USD volume"
            value={usd(selected.stats.totalVolume)}
            note={`${usd(average, true)} avg payment`}
            buckets={selected.buckets}
            metric="volume"
          />
          <MetricCard
            label={protocol === "all" ? "Observed buyers" : "Paying agents"}
            value={compact(selected.stats.uniqueSenders)}
            note={protocol === "all" ? "Protocol-level sum" : "Unique senders"}
            buckets={selected.buckets}
            metric="buyers"
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
            buckets={selected.buckets}
            metric="servers"
          />
        </div>

        {protocol === "all" && (
          <div className="protocolComparison">
            <div className="comparisonHeading">
              <div>
                <span>Protocol share</span>
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
                <span>Transaction velocity</span>
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
            <Bars buckets={selected.buckets} metric="transactions" large />
            <div className="axis">
              <span>{period === 1 ? "24 hours ago" : `${period} days ago`}</span>
              <span>Now</span>
            </div>
          </article>

          <article className="signalPanel">
            <span className="signalLabel">Signal / payment size</span>
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
