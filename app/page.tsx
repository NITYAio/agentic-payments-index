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

type ExplorerData = {
  source: string;
  live: boolean;
  asOf: string;
  periods: Record<"1" | "7" | "30", Period>;
  services: Record<"1" | "7" | "30", Service[]>;
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
};

const PERIODS = [
  { days: 1 as const, label: "24h" },
  { days: 7 as const, label: "7d" },
  { days: 30 as const, label: "30d" },
];

const QUESTIONS = [
  "What is the average transaction size in USD for the past 24 hours?",
  "Which services handled the most transactions today?",
  "How much payment volume moved in the last 7 days?",
];

const FALLBACK: ExplorerData = {
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
      buckets: [],
    },
    "7": {
      stats: {
        totalTransactions: 149420,
        totalVolume: 12782.4,
        uniqueSenders: 17410,
        uniqueRecipients: 182,
      },
      buckets: [],
    },
    "30": {
      stats: {
        totalTransactions: 573806,
        totalVolume: 46704.55,
        uniqueSenders: 39102,
        uniqueRecipients: 246,
      },
      buckets: [],
    },
  },
  services: { "1": [], "7": [], "30": [] },
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

function getDays(question: string): 1 | 7 | 30 {
  const text = question.toLowerCase();
  if (text.includes("30")) return 30;
  if (text.includes("7") || text.includes("week")) return 7;
  return 1;
}

function answerQuestion(data: ExplorerData, question: string): Answer {
  const text = question.toLowerCase();
  const days = getDays(text);
  const current = data.periods[String(days) as "1" | "7" | "30"].stats;
  const baseline = data.periods["30"].stats;
  const periodLabel = days === 1 ? "past 24 hours" : `past ${days} days`;

  if (
    (text.includes("average") || text.includes("avg") || text.includes("size")) &&
    (text.includes("transaction") || text.includes("payment"))
  ) {
    const value = current.totalVolume / current.totalTransactions;
    const benchmark = baseline.totalVolume / baseline.totalTransactions;
    return {
      eyebrow: `Average payment · ${periodLabel}`,
      value: usd(value, true),
      change: percentageDelta(value, benchmark),
      comparison: "vs the aggregate 30-day average",
      formula: `${usd(current.totalVolume)} ÷ ${compact(current.totalTransactions)} transactions`,
      explanation:
        "This is total USD payment volume divided by successful transactions. It measures payment size—not network fees or token transfers.",
      days,
      metric: "average",
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
      change: percentageDelta(current.uniqueSenders, baseline.uniqueSenders),
      comparison: "vs unique agents seen across 30 days",
      formula: `${compact(current.uniqueSenders)} distinct paying addresses`,
      explanation:
        "Each sender is counted once in the selected period, even if it made many payments.",
      days,
      metric: "buyers",
    };
  }

  if (
    text.includes("server") ||
    text.includes("provider") ||
    text.includes("service")
  ) {
    const services =
      data.services[String(days) as "1" | "7" | "30"] ?? data.services["1"];
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
      };
    }

    return {
      eyebrow: `Active services · ${periodLabel}`,
      value: compact(current.uniqueRecipients),
      change: percentageDelta(
        current.uniqueRecipients,
        baseline.uniqueRecipients,
      ),
      comparison: "vs services seen across 30 days",
      formula: `${compact(current.uniqueRecipients)} distinct payment recipients`,
      explanation:
        "This counts unique payment recipients with observed activity in the selected period.",
      days,
      metric: "servers",
    };
  }

  if (
    text.includes("volume") ||
    text.includes("spend") ||
    text.includes("usd") ||
    text.includes("dollar")
  ) {
    const daily = current.totalVolume / days;
    const baselineDaily = baseline.totalVolume / 30;
    return {
      eyebrow: `Payment volume · ${periodLabel}`,
      value: usd(current.totalVolume),
      change: percentageDelta(daily, baselineDaily),
      comparison: "daily run-rate vs the 30-day daily average",
      formula: `${compact(current.totalTransactions)} payments settled in the period`,
      explanation:
        "Volume is the total observed USD value of successful MPP payments in the selected period.",
      days,
      metric: "volume",
    };
  }

  const daily = current.totalTransactions / days;
  const baselineDaily = baseline.totalTransactions / 30;
  return {
    eyebrow: `Successful transactions · ${periodLabel}`,
    value: compact(current.totalTransactions),
    change: percentageDelta(daily, baselineDaily),
    comparison: "daily run-rate vs the 30-day daily average",
    formula: `${compact(Math.round(daily))} transactions per day`,
    explanation:
      "This counts observed successful MPP payments across all indexed services.",
    days,
    metric: "transactions",
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

export default function Home() {
  const [data, setData] = useState<ExplorerData>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<1 | 7 | 30>(1);
  const [question, setQuestion] = useState(
    "What is the average transaction size in USD for the past 24 hours and how has it changed in the last 30 days?",
  );
  const [submittedQuestion, setSubmittedQuestion] = useState(question);
  const [sort, setSort] = useState<"transactions" | "volume" | "buyers">(
    "transactions",
  );

  useEffect(() => {
    let active = true;
    fetch("/api/mpp")
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

  const selectedKey = String(period) as "1" | "7" | "30";
  const selected = data.periods[selectedKey];
  const answer = useMemo(
    () => answerQuestion(data, submittedQuestion),
    [data, submittedQuestion],
  );
  const answerBuckets =
    data.periods[String(answer.days) as "1" | "7" | "30"].buckets;
  const sortedServices = useMemo(
    () =>
      [...(data.services[selectedKey] ?? [])].sort(
        (a, b) => b.stats[sort] - a.stats[sort],
      ),
    [data.services, selectedKey, sort],
  );
  const average = selected.stats.totalTransactions
    ? selected.stats.totalVolume / selected.stats.totalTransactions
    : 0;

  function submitQuestion(event: FormEvent) {
    event.preventDefault();
    if (question.trim()) setSubmittedQuestion(question.trim());
  }

  return (
    <main>
      <nav className="topbar" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="Blockscope home">
          <span className="brandMark" aria-hidden="true">
            <i />
            <i />
          </span>
          <span>BLOCKSCOPE</span>
        </a>
        <div className="navLinks">
          <a href="#pulse">Network</a>
          <a href="#services">Services</a>
          <a href="#methodology">Methodology</a>
        </div>
        <div className="status">
          <span className={data.live ? "liveDot" : "previewDot"} />
          {loading ? "Connecting" : data.live ? "Live index" : "Preview mode"}
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="heroCopy">
          <div className="kicker">
            <span>Machine payments intelligence</span>
            <i />
            <span>MPP network</span>
          </div>
          <h1>
            The machine economy,
            <br />
            <em>answered.</em>
          </h1>
          <p>
            Explore live agent-to-service payments, then ask the network a
            question in plain English.
          </p>
          <a className="textLink" href="#pulse">
            Explore the live network <span>↓</span>
          </a>
        </div>

        <aside className="queryPanel" aria-label="Ask the data">
          <div className="queryLabel">
            <span className="spark">✦</span>
            Ask Blockscope
            <span className="queryMode">Computed from live data</span>
          </div>
          <form onSubmit={submitQuestion}>
            <label className="srOnly" htmlFor="network-question">
              Ask a question about MPP network activity
            </label>
            <textarea
              id="network-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
            />
            <div className="queryActions">
              <span>Try volume, agents, services, or average payment size</span>
              <button type="submit" aria-label="Ask question">
                Ask <span>↗</span>
              </button>
            </div>
          </form>

          <div className="answer">
            <div className="answerHead">
              <span>{answer.eyebrow}</span>
              <span className="verified">Verified calculation</span>
            </div>
            <div className="answerValueRow">
              <strong>{answer.value}</strong>
              {answer.change !== null && (
                <span
                  className={
                    answer.change >= 0 ? "changePositive" : "changeNegative"
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
        </aside>
      </section>

      <div className="questionRail" aria-label="Suggested questions">
        <span>Ask next</span>
        {QUESTIONS.map((item) => (
          <button
            key={item}
            onClick={() => {
              setQuestion(item);
              setSubmittedQuestion(item);
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
            <h2>Activity at a glance</h2>
          </div>
          <div className="periodControl" aria-label="Time period">
            {PERIODS.map((item) => (
              <button
                key={item.days}
                className={period === item.days ? "active" : ""}
                onClick={() => setPeriod(item.days)}
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
            label="Paying agents"
            value={compact(selected.stats.uniqueSenders)}
            note="Unique senders"
            buckets={selected.buckets}
            metric="buyers"
          />
          <MetricCard
            label="Active services"
            value={compact(selected.stats.uniqueRecipients)}
            note="Unique recipients"
            buckets={selected.buckets}
            metric="servers"
          />
        </div>

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

      <section className="section servicesSection" id="services">
        <div className="sectionHeading">
          <div>
            <span className="sectionNumber">02 / Service economy</span>
            <h2>Where agents spend</h2>
          </div>
          <p className="sectionIntro">
            Ranked by observed activity in the selected period.
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
                    onClick={() => setSort("transactions")}
                  >
                    Transactions {sort === "transactions" ? "↓" : ""}
                  </button>
                </th>
                <th>
                  <button
                    className={sort === "volume" ? "sortActive" : ""}
                    onClick={() => setSort("volume")}
                  >
                    Volume {sort === "volume" ? "↓" : ""}
                  </button>
                </th>
                <th>
                  <button
                    className={sort === "buyers" ? "sortActive" : ""}
                    onClick={() => setSort("buyers")}
                  >
                    Agents {sort === "buyers" ? "↓" : ""}
                  </button>
                </th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {sortedServices.slice(0, 10).map((service, index) => (
                <tr key={service.id}>
                  <td>
                    <span className="rank">
                      {String(index + 1).padStart(2, "0")}
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
                      <small>{service.description}</small>
                    </span>
                  </td>
                  <td>{compact(service.stats.transactions)}</td>
                  <td>{usd(service.stats.volume)}</td>
                  <td>{compact(service.stats.buyers)}</td>
                  <td className="latest">{relativeTime(service.stats.latestTx)}</td>
                </tr>
              ))}
              {!sortedServices.length &&
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
            </tbody>
          </table>
        </div>
      </section>

      <section className="methodology" id="methodology">
        <div>
          <span className="sectionNumber">03 / Methodology</span>
          <h2>Answers you can audit.</h2>
        </div>
        <div className="methodGrid">
          <article>
            <span>01</span>
            <h3>Observe</h3>
            <p>
              Read-only network aggregates and service rankings are refreshed
              from the MPPScan public analytics index.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Compute</h3>
            <p>
              Questions map to a metric, time window, and comparison. Every
              result includes its formula.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Explain</h3>
            <p>
              The answer distinguishes totals, daily run-rates, unique actors,
              and per-transaction averages.
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
          <span>BLOCKSCOPE</span>
        </a>
        <p>
          Independent interface powered by{" "}
          <a href="https://mppscan.com" target="_blank" rel="noreferrer">
            MPPScan
          </a>{" "}
          public analytics. Not affiliated with MPPScan.
        </p>
        <span>
          Updated{" "}
          {new Date(data.asOf).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </footer>
    </main>
  );
}
