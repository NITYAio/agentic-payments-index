#!/usr/bin/env node

const DAY_MS = 86_400_000;
const origin = (process.env.PRODUCTION_ORIGIN ?? "https://agenticpaymentsindex.org").replace(/\/$/, "");
const maxAgeHours = Number(process.env.FRESHNESS_MAX_AGE_HOURS ?? 30);
const knownBlockedProtocols = new Set(
  (process.env.KNOWN_BLOCKED_PROTOCOLS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

async function json(path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
  return response.json();
}

function validateProtocolWindow(payload, protocol, days) {
  if (!payload.available) throw new Error(`${days}d direct-source data is unavailable.`);
  const metric = payload.windowMetrics.find((row) => row.protocol === protocol);
  if (!metric) throw new Error(`${protocol} ${days}d window is missing.`);
  const duration = new Date(metric.rangeEnd).getTime() - new Date(metric.rangeStart).getTime();
  if (duration !== days * DAY_MS) {
    throw new Error(`${protocol} ${days}d window has an incorrect duration.`);
  }
  const ageHours = (Date.now() - new Date(metric.rangeEnd).getTime()) / 3_600_000;
  if (ageHours < -0.1 || ageHours > maxAgeHours) {
    throw new Error(`${protocol} ${days}d window is ${ageHours.toFixed(1)} hours old.`);
  }
  for (const field of ["transactionCount", "volumeUsd", "buyerCount", "sellerCount"]) {
    if (!Number.isFinite(Number(metric[field])) || Number(metric[field]) < 0) {
      throw new Error(`${protocol} ${days}d returned invalid ${field}.`);
    }
  }
  return metric;
}

async function main() {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error("FRESHNESS_MAX_AGE_HOURS must be a positive number.");
  }
  const windows = await Promise.all(
    [1, 7, 30].map(async (days) => ({
      days,
      payload: await json(`/api/direct-source?protocol=all&days=${days}`),
    })),
  );
  const warnings = [];
  const verified = [];
  for (const { days, payload } of windows) {
    for (const protocol of ["mpp", "x402"]) {
      try {
        verified.push({ days, metric: validateProtocolWindow(payload, protocol, days) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!knownBlockedProtocols.has(protocol)) throw error;
        warnings.push(message);
        process.stdout.write(`::warning title=${protocol} freshness is evidence-gated::${message}\n`);
      }
    }
  }

  const mppHistory = await json("/api/direct-source?protocol=mpp&days=0");
  const allTime = mppHistory.windowMetrics.find((row) => row.protocol === "mpp");
  if (!allTime) throw new Error("MPP all-time history is missing.");
  const historyDays =
    (new Date(allTime.rangeEnd).getTime() - new Date(allTime.rangeStart).getTime()) / DAY_MS;
  if (historyDays <= 30 || mppHistory.metrics.length !== historyDays) {
    throw new Error("MPP all-time history is incomplete or has missing daily rows.");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      checkedAt: new Date().toISOString(),
      maxAgeHours,
      knownBlockedProtocols: [...knownBlockedProtocols],
      warnings,
      rollingWindows: windows.map(({ days }) => ({
        days,
        protocols: verified
          .filter((item) => item.days === days)
          .map(({ metric }) => ({
            protocol: metric.protocol,
            rangeEnd: metric.rangeEnd,
            transactions: metric.transactionCount,
          })),
      })),
      mppAllTime: {
        rangeStart: allTime.rangeStart,
        rangeEnd: allTime.rangeEnd,
        transactions: allTime.transactionCount,
      },
      x402AllTime: "evidence-gated until terminal-recipient identity history is complete",
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
