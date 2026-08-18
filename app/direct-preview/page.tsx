"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type DailyMetric = {
  protocol: "mpp" | "x402";
  network: string;
  activityDate: string;
  measurementUnit: "protocol_payment" | "onchain_settlement";
  transactionCount: number;
  chargeCount: number;
  sessionCount: number;
  rawTransferCount: number;
  volumeUsd: number;
  recipientVolumeUsd: number;
  grossTransferVolumeUsd: number;
  chargeVolumeUsd: number;
  sessionVolumeUsd: number;
  buyerCount: number;
  sellerCount: number;
  evidenceLevel: string;
  adjusted: boolean;
  limitation: string;
};

type WindowMetric = Omit<DailyMetric, "activityDate"> & {
  rangeStart: string;
  rangeEnd: string;
};

type Coverage = {
  protocol: "mpp" | "x402";
  network: string;
  sourceType: string;
  sourceUrl: string;
  coverageStart: string;
  coverageEnd: string;
  status: string;
  limitation: string;
};

type DirectData = {
  available: boolean;
  requestedDays: number;
  metrics: DailyMetric[];
  windowMetrics: WindowMetric[];
  coverage: Coverage[];
  disclosure: string;
};

const WINDOW_OPTIONS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 0, label: "All" },
] as const;

function compact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function dollars(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function date(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function timestamp(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function protocolName(protocol: "mpp" | "x402") {
  return protocol === "mpp" ? "MPP" : "x402";
}

function DailyBars({ metrics }: { metrics: DailyMetric[] }) {
  const maximum = Math.max(...metrics.map((metric) => metric.transactionCount), 1);
  return (
    <div className="directBars" aria-label="Daily transaction count">
      <div className="directBarPlot">
        {metrics.map((metric) => (
          <i
            key={`${metric.protocol}-${metric.activityDate}`}
            style={{ height: `${Math.max(3, (metric.transactionCount / maximum) * 100)}%` }}
            title={`${date(metric.activityDate)} · ${metric.transactionCount.toLocaleString("en-US")} transactions`}
          />
        ))}
      </div>
      <div className="directBarAxis">
        <span>{metrics[0] ? date(metrics[0].activityDate) : "—"}</span>
        <span>{metrics.at(-1) ? date(metrics.at(-1)!.activityDate) : "—"}</span>
      </div>
    </div>
  );
}

export default function DirectPreview() {
  const [data, setData] = useState<DirectData | null>(null);
  const [error, setError] = useState("");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetch(`/api/direct-source?protocol=all&days=${days}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("The direct-source preview is unavailable.");
        return (await response.json()) as DirectData;
      })
      .then((payload) => {
        if (active) {
          setData(payload);
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (active && reason?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : "Preview unavailable.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [days]);

  const grouped = useMemo(
    () =>
      ({
        mpp: data?.metrics.filter((metric) => metric.protocol === "mpp") ?? [],
        x402: data?.metrics.filter((metric) => metric.protocol === "x402") ?? [],
      }) as const,
    [data],
  );

  return (
    <main className="directPreview">
      <nav className="directPreviewNav">
        <Link className="brand" href="/">
          <span className="brandMark" aria-hidden="true"><i /><i /></span>
          <span>THE AGENTIC PAYMENTS INDEX</span>
        </Link>
        <span>Private verification surface</span>
      </nav>

      <header className="directPreviewHero">
        <div>
          <span className="sectionNumber">Direct-source cutover review</span>
          <h1>Same market.<br /><em>Primary evidence.</em></h1>
        </div>
        <div className="directPreviewIntro">
          <p>
            Exact rolling-window comparisons of independently collected MPP and
            x402 activity. Payment value is counted once at the payer&apos;s original
            amount; recipient value and gross transfer movement remain available for audit.
          </p>
          <span>All boundaries and dates use UTC.</span>
        </div>
      </header>

      <section className="directWindowBar" aria-label="Select an exact rolling window">
        <div className="directWindowControl">
          {WINDOW_OPTIONS.map((option) => (
            <button
              className={days === option.days ? "active" : ""}
              key={option.days}
              onClick={() => {
                if (option.days === days) return;
                setLoading(true);
                setError("");
                setDays(option.days);
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <p>
          {data?.windowMetrics[0]
            ? `${timestamp(data.windowMetrics[0].rangeStart)}–${timestamp(data.windowMetrics[0].rangeEnd)}`
            : "Waiting for a verified window"}
        </p>
      </section>

      {error ? <section className="directPreviewState">{error}</section> : null}
      {loading && !error ? <section className="directPreviewState">Loading verified evidence…</section> : null}
      {days === 0 && data?.available && !loading && !data.windowMetrics.some((metric) => metric.protocol === "x402") ? (
        <section className="directPreviewState">
          MPP History is available. x402 and combined History views remain unavailable
          until terminal-recipient identity history is complete.
        </section>
      ) : null}

      {data?.available && !loading ? (
        <>
          <section className="directProtocolGrid">
            {(["mpp", "x402"] as const).map((protocol) => {
              const metric = data.windowMetrics.find((item) => item.protocol === protocol);
              const coverage = data.coverage.find((item) => item.protocol === protocol);
              if (!metric) return null;
              const valueLabel = "Payment value";
              const sellerLabel = protocol === "mpp" ? "Active server identities" : "Recipient addresses";
              return (
                <article className={`directProtocolCard ${protocol}`} key={protocol}>
                  <div className="directProtocolHead">
                    <div>
                      <span>{protocolName(protocol)} · {metric.network}</span>
                      <h2>Payments</h2>
                    </div>
                    <span className="directStatus"><i /> deterministic</span>
                  </div>

                  <div className="directMetricGrid">
                    <div><small>Transactions</small><strong>{compact(metric.transactionCount)}</strong></div>
                    <div><small>{valueLabel}</small><strong>{dollars(metric.volumeUsd)}</strong></div>
                    <div><small>{protocol === "mpp" ? "Buyer identities" : "Payer addresses"}</small><strong>{compact(metric.buyerCount)}</strong></div>
                    <div><small>{sellerLabel}</small><strong>{compact(metric.sellerCount)}</strong></div>
                  </div>

                  {protocol === "mpp" ? (
                    <div className="directMppBreakdown" aria-label="MPP payment-mode breakdown">
                      <div><small>One-shot charges</small><strong>{compact(metric.chargeCount)}</strong><span>{dollars(metric.chargeVolumeUsd)}</span></div>
                      <div><small>Session settlements</small><strong>{compact(metric.sessionCount)}</strong><span>{dollars(metric.sessionVolumeUsd)}</span></div>
                    </div>
                  ) : (
                    <div className="directMppBreakdown" aria-label="x402 transfer audit">
                      <div><small>Final recipients received</small><strong>{dollars(metric.recipientVolumeUsd)}</strong><span>after routing</span></div>
                      <div><small>Gross transfer movement</small><strong>{dollars(metric.grossTransferVolumeUsd)}</strong><span>{compact(metric.rawTransferCount)} raw legs</span></div>
                    </div>
                  )}

                  <DailyBars metrics={grouped[protocol]} />

                  <dl className="directEvidenceList">
                    <div><dt>Window</dt><dd>{timestamp(metric.rangeStart)}–{timestamp(metric.rangeEnd)}</dd></div>
                    <div><dt>Unit</dt><dd>{metric.measurementUnit.replaceAll("_", " ")}</dd></div>
                    <div><dt>Source</dt><dd>{coverage?.sourceType.replaceAll("_", " ") ?? "—"}</dd></div>
                    <div><dt>Quality filters</dt><dd>{metric.adjusted ? "Applied" : "Not yet applied"}</dd></div>
                  </dl>
                  <p className="directLimitation">{metric.limitation}</p>
                </article>
              );
            })}
          </section>

          <section className="directDecisionGrid">
            <article>
              <span>Ready</span>
              <strong>Exact rolling windows</strong>
              <p>Twenty-four hours, seven days, and thirty days use exact half-open boundaries—not approximate source buckets.</p>
            </article>
            <article>
              <span>MPP method locked</span>
              <strong>Charges plus session settlements</strong>
              <p>One-shot charges and TIP-1034 settlements remain queryable separately and combine into the defensible MPP payment total.</p>
            </article>
            <article>
              <span>Transfer routing normalized</span>
              <strong>x402 payment value</strong>
              <p>Receive-and-forward chains count once at the payer&apos;s original amount and are attributed to the final recipient. Gross movement remains visible for audit.</p>
            </article>
            <article>
              <span>Identity definition</span>
              <strong>Protocol fingerprints, not wallets</strong>
              <p>Active server identities use the fingerprint embedded in a valid MPP memo. They are not assumed to equal companies.</p>
            </article>
          </section>

          <section className="directDisclosure">
            <span>Data contract</span>
            <p>{data.disclosure}</p>
            <a href="/coverage">Review public coverage language ↗</a>
          </section>
        </>
      ) : null}
    </main>
  );
}
