import { getD1 } from "../../../db";

type ProtocolKey = "all" | "mpp" | "x402";
type TrustWindowRow = {
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
  activity_date: string;
  qualifying_payment_count: number;
  qualifying_volume_usd_micros: number;
  median_payment_usd_micros: number;
  max_payment_usd_micros: number;
};

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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const protocol = parseProtocol(url.searchParams.get("protocol"));
  const days = parseDays(url.searchParams.get("days"));

  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
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
      // Fall through to local D1 so offline development still has a truthful gate.
    }
  }

  if (protocol === "x402") {
    return unavailable(
      protocol,
      days,
      "x402 ticket-size classification awaits the Base historical source. No x402 threshold is published until terminal payments can be classified reproducibly.",
    );
  }
  if (days === 0 || days === 90) {
    return unavailable(
      protocol,
      days,
      "MPP daily ticket-size evidence is live for 7- and 30-day windows. The longer history is being reprocessed with the same exclusions before it is published.",
    );
  }

  try {
    const d1 = await getD1();
    const result = await d1
      .prepare(
        `SELECT run_id, range_start, range_end, qualifying_payment_count,
                qualifying_volume_usd_micros, median_payment_usd_micros,
                max_payment_usd_micros, over_one_count, over_ten_count,
                over_hundred_count, over_thousand_count, excluded_zero_count,
                excluded_self_count, updated_at
         FROM protocol_window_metrics
         WHERE protocol = 'mpp'
         ORDER BY range_end DESC`,
      )
      .all<TrustWindowRow>();
    const durationMs = days * 86_400_000;
    const window = result.results.find(
      (row) => new Date(row.range_end).getTime() - new Date(row.range_start).getTime() === durationMs,
    );
    if (!window || window.qualifying_payment_count < 1) {
      return unavailable(
        protocol,
        days,
        "MPP payment evidence is present, but this window has not yet been reprocessed through the verified ticket-size exclusions.",
      );
    }
    const daily = await d1
      .prepare(
        `SELECT activity_date, qualifying_payment_count, qualifying_volume_usd_micros,
                median_payment_usd_micros, max_payment_usd_micros
         FROM daily_protocol_metrics
         WHERE run_id = ?
         ORDER BY activity_date ASC`,
      )
      .bind(window.run_id)
      .all<TrustDailyRow>();
    const daysSinceTracking = Math.max(
      1,
      Math.ceil(
        (new Date(window.range_end).getTime() - new Date(window.range_start).getTime()) /
          86_400_000,
      ),
    );
    const reason = protocol === "all"
      ? "MPP ticket sizes are verified. x402 remains outside this result until the Base historical classifier is available."
      : "Zero-value and self-payments are excluded from protocol-attributed MPP charges and settled sessions.";
    return Response.json(
      {
        available: true,
        status: protocol === "all" ? "partial" : "verified",
        protocol,
        scope: "mpp",
        days,
        coverageStart: window.range_start,
        coverageEnd: window.range_end,
        reason,
        methodology: "/coverage#trust-barometer-method",
        metrics: {
          qualifyingPaymentCount: window.qualifying_payment_count,
          qualifyingVolumeUsd: window.qualifying_volume_usd_micros / 1_000_000,
          averagePaymentUsd:
            window.qualifying_volume_usd_micros /
            1_000_000 /
            window.qualifying_payment_count,
          medianPaymentUsd: window.median_payment_usd_micros / 1_000_000,
          maxPaymentUsd: window.max_payment_usd_micros / 1_000_000,
          excludedZeroCount: window.excluded_zero_count,
          excludedSelfCount: window.excluded_self_count,
          daysSinceTracking,
          thresholds: [
            { amount: 1, count: window.over_one_count, delta: null },
            { amount: 10, count: window.over_ten_count, delta: null },
            { amount: 100, count: window.over_hundred_count, delta: null },
            { amount: 1_000, count: window.over_thousand_count, delta: null },
          ],
          series: daily.results.map((row) => ({
            date: row.activity_date,
            qualifyingPaymentCount: row.qualifying_payment_count,
            averagePaymentUsd: row.qualifying_payment_count
              ? row.qualifying_volume_usd_micros / 1_000_000 / row.qualifying_payment_count
              : null,
            medianPaymentUsd: row.qualifying_payment_count
              ? row.median_payment_usd_micros / 1_000_000
              : null,
            maxPaymentUsd: row.qualifying_payment_count
              ? row.max_payment_usd_micros / 1_000_000
              : null,
          })),
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
