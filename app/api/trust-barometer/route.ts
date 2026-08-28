import { getD1 } from "../../../db";

type ProtocolKey = "all" | "mpp" | "x402";
type SourceProtocol = Exclude<ProtocolKey, "all">;

type TrustWindowRow = {
  protocol: SourceProtocol;
  run_id: string;
  range_start: string;
  range_end: string;
  qualifying_payment_count: number;
  qualifying_volume_usd_micros: number;
  median_payment_usd_micros: number;
  max_payment_usd_micros: number;
  over_one_count: number;
  over_ten_count: number;
  over_hundred_count: number;
  over_thousand_count: number;
  excluded_zero_count: number;
  excluded_self_count: number;
  updated_at: string;
};

type TrustDailyRow = {
  protocol: SourceProtocol;
  activity_date: string;
  qualifying_payment_count: number;
  qualifying_volume_usd_micros: number;
  median_payment_usd_micros: number;
  max_payment_usd_micros: number;
  over_one_count: number;
  over_ten_count: number;
  over_hundred_count: number;
  over_thousand_count: number;
  excluded_zero_count: number;
  excluded_self_count: number;
};

type TrustAccumulator = {
  qualifyingPaymentCount: number;
  qualifyingVolumeUsdMicros: number;
  maxPaymentUsdMicros: number;
  overOneCount: number;
  overTenCount: number;
  overHundredCount: number;
  overThousandCount: number;
  excludedZeroCount: number;
  excludedSelfCount: number;
};

const DAY_MS = 86_400_000;

function parseProtocol(value: string | null): ProtocolKey {
  return value === "mpp" || value === "x402" ? value : "all";
}

function parseDays(value: string | null): 0 | 7 | 30 | 90 {
  if (value === "0" || value === "7" || value === "90") return Number(value) as 0 | 7 | 90;
  return 30;
}

function unavailable(protocol: ProtocolKey, days: 0 | 7 | 30 | 90, reason: string) {
  return Response.json(
    {
      available: false,
      status: "unavailable",
      protocol,
      scope: null,
      days,
      coverageStart: null,
      coverageEnd: null,
      reason,
      methodology: "/coverage#trust-barometer-method",
      metrics: null,
    },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } },
  );
}

function durationMs(row: TrustWindowRow) {
  return new Date(row.range_end).getTime() - new Date(row.range_start).getTime();
}

function isExactWindow(row: TrustWindowRow, days: 7 | 30) {
  return Math.round(durationMs(row) / DAY_MS) === days;
}

function emptyAccumulator(): TrustAccumulator {
  return {
    qualifyingPaymentCount: 0,
    qualifyingVolumeUsdMicros: 0,
    maxPaymentUsdMicros: 0,
    overOneCount: 0,
    overTenCount: 0,
    overHundredCount: 0,
    overThousandCount: 0,
    excludedZeroCount: 0,
    excludedSelfCount: 0,
  };
}

function addWindow(total: TrustAccumulator, row: TrustWindowRow) {
  total.qualifyingPaymentCount += row.qualifying_payment_count;
  total.qualifyingVolumeUsdMicros += row.qualifying_volume_usd_micros;
  total.maxPaymentUsdMicros = Math.max(total.maxPaymentUsdMicros, row.max_payment_usd_micros);
  total.overOneCount += row.over_one_count;
  total.overTenCount += row.over_ten_count;
  total.overHundredCount += row.over_hundred_count;
  total.overThousandCount += row.over_thousand_count;
  total.excludedZeroCount += row.excluded_zero_count;
  total.excludedSelfCount += row.excluded_self_count;
}

function addDaily(total: TrustAccumulator, row: TrustDailyRow) {
  total.qualifyingPaymentCount += row.qualifying_payment_count;
  total.qualifyingVolumeUsdMicros += row.qualifying_volume_usd_micros;
  total.maxPaymentUsdMicros = Math.max(total.maxPaymentUsdMicros, row.max_payment_usd_micros);
  total.overOneCount += row.over_one_count;
  total.overTenCount += row.over_ten_count;
  total.overHundredCount += row.over_hundred_count;
  total.overThousandCount += row.over_thousand_count;
  total.excludedZeroCount += row.excluded_zero_count;
  total.excludedSelfCount += row.excluded_self_count;
}

function percentDelta(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function monthKey(date: string) {
  return date.slice(0, 7);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const protocol = parseProtocol(url.searchParams.get("protocol"));
  const days = parseDays(url.searchParams.get("days"));

  const useLocalSnapshot = url.searchParams.get("source") === "local";
  if (!useLocalSnapshot && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    const published = new URL("https://agenticpaymentsindex.org/api/trust-barometer");
    published.searchParams.set("protocol", protocol);
    published.searchParams.set("days", String(days));
    published.searchParams.set("preview", String(Date.now()));
    try {
      const response = await fetch(published, { cache: "no-store" });
      if (response.ok) {
        return Response.json(await response.json(), {
          headers: { "Cache-Control": "no-store" },
        });
      }
    } catch {
      // Fall through to local D1 so offline development retains a truthful gate.
    }
  }

  const protocols: SourceProtocol[] = protocol === "all" ? ["mpp", "x402"] : [protocol];

  try {
    const d1 = await getD1();
    const placeholders = protocols.map(() => "?").join(", ");
    const result = await d1
      .prepare(
        `SELECT protocol, run_id, range_start, range_end, qualifying_payment_count,
                qualifying_volume_usd_micros, median_payment_usd_micros,
                max_payment_usd_micros, over_one_count, over_ten_count,
                over_hundred_count, over_thousand_count, excluded_zero_count,
                excluded_self_count, updated_at
         FROM protocol_window_metrics
         WHERE protocol IN (${placeholders})
         ORDER BY range_end DESC`,
      )
      .bind(...protocols)
      .all<TrustWindowRow>();

    const histories = protocols.map((sourceProtocol) => {
      const rows = result.results.filter((row) => row.protocol === sourceProtocol);
      return rows.sort((a, b) => durationMs(b) - durationMs(a))[0] ?? null;
    });
    if (histories.some((row) => !row)) {
      return unavailable(
        protocol,
        days,
        "Verified ticket-size history is not yet available for every selected protocol.",
      );
    }
    const historyWindows = histories.filter((row): row is TrustWindowRow => Boolean(row));

    const exactWindows = days === 7 || days === 30
      ? protocols.map((sourceProtocol) =>
          result.results.find(
            (row) => row.protocol === sourceProtocol && isExactWindow(row, days),
          ) ?? null,
        )
      : [];
    if ((days === 7 || days === 30) && exactWindows.some((row) => !row)) {
      return unavailable(
        protocol,
        days,
        "This exact rolling window has not yet completed verified ticket-size processing for every selected protocol.",
      );
    }
    const selectedWindows = days === 0
      ? historyWindows
      : days === 7 || days === 30
        ? exactWindows.filter((row): row is TrustWindowRow => Boolean(row))
        : historyWindows;

    // The widest run already contains the canonical daily history. Querying both it
    // and a rolling-window run would duplicate the same dates in charts and deltas.
    const runIds = [...new Set(historyWindows.map((row) => row.run_id))];
    const runPlaceholders = runIds.map(() => "?").join(", ");
    const dailyResult = await d1
      .prepare(
        `SELECT protocol, activity_date, qualifying_payment_count,
                qualifying_volume_usd_micros, median_payment_usd_micros,
                max_payment_usd_micros, over_one_count, over_ten_count,
                over_hundred_count, over_thousand_count, excluded_zero_count,
                excluded_self_count
         FROM daily_protocol_metrics
         WHERE run_id IN (${runPlaceholders})
         ORDER BY activity_date ASC`,
      )
      .bind(...runIds)
      .all<TrustDailyRow>();

    const coverageEndMs = Math.min(...selectedWindows.map((row) => new Date(row.range_end).getTime()));
    const requestedStartMs = days === 0 ? Number.NEGATIVE_INFINITY : coverageEndMs - days * DAY_MS;
    const commonHistoryStartMs = Math.max(
      ...historyWindows.map((row) => new Date(row.range_start).getTime()),
    );
    if (days === 90 && requestedStartMs < commonHistoryStartMs) {
      return unavailable(
        protocol,
        days,
        `A full 90-day comparison is not yet available. Verified common history begins ${new Date(commonHistoryStartMs).toISOString().slice(0, 10)}.`,
      );
    }
    const coverageStartMs = days === 0
      ? Math.min(...selectedWindows.map((row) => new Date(row.range_start).getTime()))
      : Math.max(requestedStartMs, commonHistoryStartMs);
    const coverageStart = new Date(coverageStartMs).toISOString();
    const coverageEnd = new Date(coverageEndMs).toISOString();
    const currentDaily = dailyResult.results.filter((row) => {
      const time = new Date(`${row.activity_date}T00:00:00.000Z`).getTime();
      return time >= coverageStartMs && time < coverageEndMs;
    });

    const totals = emptyAccumulator();
    if (days === 90) {
      currentDaily.forEach((row) => addDaily(totals, row));
    } else {
      selectedWindows.forEach((row) => addWindow(totals, row));
    }
    if (totals.qualifyingPaymentCount < 1) {
      return unavailable(
        protocol,
        days,
        "Paid protocol-attributed observations are present, but none qualify for this selected window after the published exclusions.",
      );
    }

    const dates = [...new Set(currentDaily.map((row) => row.activity_date))].sort();
    const series = dates.map((date) => {
      const rows = currentDaily.filter((row) => row.activity_date === date);
      const dailyTotal = emptyAccumulator();
      rows.forEach((row) => addDaily(dailyTotal, row));
      const soleRow = rows.length === 1 ? rows[0] : null;
      const exactMedian = soleRow?.qualifying_payment_count
        ? soleRow.median_payment_usd_micros / 1_000_000
        : null;
      return {
        date,
        qualifyingPaymentCount: dailyTotal.qualifyingPaymentCount,
        averagePaymentUsd: dailyTotal.qualifyingPaymentCount
          ? dailyTotal.qualifyingVolumeUsdMicros / 1_000_000 / dailyTotal.qualifyingPaymentCount
          : null,
        medianPaymentUsd: exactMedian,
        maxPaymentUsd: dailyTotal.qualifyingPaymentCount
          ? dailyTotal.maxPaymentUsdMicros / 1_000_000
          : null,
      };
    });

    const priorStartMs = days === 0 ? null : coverageStartMs - (coverageEndMs - coverageStartMs);
    const previousDaily = priorStartMs === null
      ? []
      : dailyResult.results.filter((row) => {
          const time = new Date(`${row.activity_date}T00:00:00.000Z`).getTime();
          return time >= priorStartMs && time < coverageStartMs;
        });
    const previousTotals = emptyAccumulator();
    previousDaily.forEach((row) => addDaily(previousTotals, row));
    const priorPeriodComplete = priorStartMs !== null && priorStartMs >= commonHistoryStartMs;

    const monthly = new Map<string, [number, number, number, number]>();
    currentDaily.forEach((row) => {
      const key = monthKey(row.activity_date);
      const value = monthly.get(key) ?? [0, 0, 0, 0];
      value[0] += row.over_one_count;
      value[1] += row.over_ten_count;
      value[2] += row.over_hundred_count;
      value[3] += row.over_thousand_count;
      monthly.set(key, value);
    });
    const monthlyPeriods = [...monthly.keys()].sort();
    const thresholdValues = [
      [1, totals.overOneCount, previousTotals.overOneCount],
      [10, totals.overTenCount, previousTotals.overTenCount],
      [100, totals.overHundredCount, previousTotals.overHundredCount],
      [1_000, totals.overThousandCount, previousTotals.overThousandCount],
    ] as const;

    const exactMedian = protocols.length === 1 && days !== 90 && selectedWindows[0]
      ? selectedWindows[0].median_payment_usd_micros / 1_000_000
      : null;
    const earliestTrackingMs = Math.min(
      ...historyWindows.map((row) => new Date(row.range_start).getTime()),
    );
    const daysSinceTracking = Math.max(1, Math.ceil((coverageEndMs - earliestTrackingMs) / DAY_MS));
    const reason = protocol === "all"
      ? "MPP charges and sessions are combined with terminal x402 settlements after each protocol's exclusions. Counts and value are additive; a combined median is not fabricated because medians cannot be added."
      : protocol === "x402"
        ? "Terminal x402 settlements are counted once after receive-then-forward normalization. Zero-value and self-payments are excluded; unresolved ownership remains outside coverage."
        : "Zero-value and self-payments are excluded from protocol-attributed MPP charges and settled sessions.";

    return Response.json(
      {
        available: true,
        status: "verified",
        protocol,
        scope: protocol,
        days,
        coverageStart,
        coverageEnd,
        reason,
        methodology: "/coverage#trust-barometer-method",
        metrics: {
          qualifyingPaymentCount: totals.qualifyingPaymentCount,
          qualifyingVolumeUsd: totals.qualifyingVolumeUsdMicros / 1_000_000,
          averagePaymentUsd:
            totals.qualifyingVolumeUsdMicros / 1_000_000 / totals.qualifyingPaymentCount,
          medianPaymentUsd: exactMedian,
          maxPaymentUsd: totals.maxPaymentUsdMicros / 1_000_000,
          excludedZeroCount: totals.excludedZeroCount,
          excludedSelfCount: totals.excludedSelfCount,
          daysSinceTracking,
          thresholds: thresholdValues.map(([amount, count, previous], index) => ({
            amount,
            count,
            delta: priorPeriodComplete ? percentDelta(count, previous) : null,
            series: monthlyPeriods.map((period) => ({
              period,
              count: monthly.get(period)?.[index] ?? 0,
            })),
          })),
          series,
        },
      },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } },
    );
  } catch (error) {
    return unavailable(
      protocol,
      days,
      error instanceof Error
        ? `Ticket-size evidence is temporarily unavailable: ${error.message}`
        : "Ticket-size evidence is temporarily unavailable.",
    );
  }
}
