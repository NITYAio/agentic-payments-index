import { getD1 } from "../../../db";

type MetricRow = {
  run_id: string;
  protocol: "mpp" | "x402";
  network: string;
  activity_date: string;
  measurement_unit: "protocol_payment" | "onchain_settlement" | "settlement_transfer";
  transaction_count: number;
  charge_count: number;
  session_count: number;
  settlement_count: number;
  volume_usd_micros: number;
  charge_volume_usd_micros: number;
  session_volume_usd_micros: number;
  buyer_count: number;
  seller_count: number;
  evidence_level: string;
  is_adjusted: number;
  limitation: string | null;
  updated_at: string;
};

type CoverageRow = {
  source_key: string;
  protocol: "mpp" | "x402";
  network: string;
  measurement_unit: string;
  source_type: string;
  source_url: string;
  coverage_start: string | null;
  coverage_end: string | null;
  last_successful_sync_at: string | null;
  status: string;
  limitation: string;
  methodology_url: string;
  updated_at: string;
};

type WindowMetricRow = {
  run_id: string;
  protocol: "mpp" | "x402";
  network: string;
  range_start: string;
  range_end: string;
  measurement_unit: "protocol_payment" | "onchain_settlement" | "settlement_transfer";
  transaction_count: number;
  charge_count: number;
  session_count: number;
  settlement_count: number;
  volume_usd_micros: number;
  charge_volume_usd_micros: number;
  session_volume_usd_micros: number;
  buyer_count: number;
  seller_count: number;
  evidence_level: string;
  is_adjusted: number;
  limitation: string | null;
  updated_at: string;
};

function requestOptions(request: Request) {
  const url = new URL(request.url);
  const selected = url.searchParams.get("protocol") ?? "all";
  if (selected !== "all" && selected !== "mpp" && selected !== "x402") {
    throw new Error("Protocol must be all, mpp, or x402.");
  }
  const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
    throw new Error("Days must be an integer between 1 and 366.");
  }
  return { selected, days };
}

export async function GET(request: Request) {
  try {
    const { selected, days } = requestOptions(request);
    const d1 = await getD1();
    const protocolClause = selected === "all" ? "" : " AND protocol = ?";
    const coverageQuery = d1.prepare(
      `SELECT source_key, protocol, network, measurement_unit, source_type, source_url,
              coverage_start, coverage_end, last_successful_sync_at, status,
              limitation, methodology_url, updated_at
       FROM source_coverage
       WHERE 1 = 1${protocolClause}
       ORDER BY protocol ASC, network ASC`,
    );
    const windowQuery = d1.prepare(
      `SELECT run_id, protocol, network, range_start, range_end, measurement_unit,
              transaction_count, charge_count, session_count, settlement_count,
              volume_usd_micros, charge_volume_usd_micros, session_volume_usd_micros,
              buyer_count, seller_count, evidence_level, is_adjusted,
              limitation, updated_at
       FROM protocol_window_metrics
       WHERE range_end >= ?${protocolClause}
       ORDER BY range_end DESC, protocol ASC, network ASC`,
    );
    const coverageStatement =
      selected === "all" ? coverageQuery : coverageQuery.bind(selected);
    const earliestWindow = new Date();
    earliestWindow.setUTCDate(earliestWindow.getUTCDate() - 367);
    const earliestWindowIso = earliestWindow.toISOString();
    const windowStatement =
      selected === "all"
        ? windowQuery.bind(earliestWindowIso)
        : windowQuery.bind(earliestWindowIso, selected);
    const [coverageResult, windowResult] = await Promise.all([
      coverageStatement.all<CoverageRow>(),
      windowStatement.all<WindowMetricRow>(),
    ]);
    const coverage = coverageResult.results.map((row) => ({
      sourceKey: row.source_key,
      protocol: row.protocol,
      network: row.network,
      measurementUnit: row.measurement_unit,
      sourceType: row.source_type,
      sourceUrl: row.source_url,
      coverageStart: row.coverage_start,
      coverageEnd: row.coverage_end,
      lastSuccessfulSyncAt: row.last_successful_sync_at,
      status: row.status,
      limitation: row.limitation,
      methodologyUrl: row.methodology_url,
      updatedAt: row.updated_at,
    }));
    const requestedWindowMs = days * 86_400_000;
    const seenProtocols = new Set<string>();
    const windowMetrics = windowResult.results
      .filter(
        (row) =>
          new Date(row.range_end).getTime() - new Date(row.range_start).getTime() ===
          requestedWindowMs,
      )
      .filter((row) => {
        const key = `${row.protocol}|${row.network}|${row.measurement_unit}`;
        if (seenProtocols.has(key)) return false;
        seenProtocols.add(key);
        return true;
      })
      .map((row) => ({
        runId: row.run_id,
        protocol: row.protocol,
        network: row.network,
        rangeStart: row.range_start,
        rangeEnd: row.range_end,
        measurementUnit: row.measurement_unit,
        transactionCount: row.transaction_count,
        chargeCount: row.charge_count,
        sessionCount: row.session_count,
        settlementCount: row.settlement_count,
        volumeUsd: row.volume_usd_micros / 1_000_000,
        chargeVolumeUsd: row.charge_volume_usd_micros / 1_000_000,
        sessionVolumeUsd: row.session_volume_usd_micros / 1_000_000,
        buyerCount: row.buyer_count,
        sellerCount: row.seller_count,
        evidenceLevel: row.evidence_level,
        adjusted: Boolean(row.is_adjusted),
        limitation: row.limitation,
        updatedAt: row.updated_at,
      }));
    const runIds = windowMetrics.map((metric) => metric.runId);
    const metricResult = runIds.length
      ? await d1
          .prepare(
            `SELECT run_id, protocol, network, activity_date, measurement_unit,
                    transaction_count, charge_count, session_count, settlement_count,
                    volume_usd_micros, charge_volume_usd_micros,
                    session_volume_usd_micros, buyer_count, seller_count,
                    evidence_level, is_adjusted, limitation, updated_at
             FROM daily_protocol_metrics
             WHERE run_id IN (${runIds.map(() => "?").join(", ")})
             ORDER BY activity_date ASC, protocol ASC, network ASC`,
          )
          .bind(...runIds)
          .all<MetricRow>()
      : { results: [] as MetricRow[] };
    const metrics = metricResult.results.map((row) => ({
      runId: row.run_id,
      protocol: row.protocol,
      network: row.network,
      activityDate: row.activity_date,
      measurementUnit: row.measurement_unit,
      transactionCount: row.transaction_count,
      chargeCount: row.charge_count,
      sessionCount: row.session_count,
      settlementCount: row.settlement_count,
      volumeUsd: row.volume_usd_micros / 1_000_000,
      chargeVolumeUsd: row.charge_volume_usd_micros / 1_000_000,
      sessionVolumeUsd: row.session_volume_usd_micros / 1_000_000,
      buyerCount: row.buyer_count,
      sellerCount: row.seller_count,
      evidenceLevel: row.evidence_level,
      adjusted: Boolean(row.is_adjusted),
      limitation: row.limitation,
      updatedAt: row.updated_at,
    }));
    return Response.json(
      {
        available: metrics.length > 0,
        protocol: selected,
        requestedDays: days,
        metrics,
        windowMetrics,
        coverage,
        disclosure:
          "Window identity counts are period-wide distinct identities; daily identity counts are chart context and are never summed. Different measurement units are not silently combined.",
      },
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Direct-source data is unavailable." },
      { status: 400 },
    );
  }
}
