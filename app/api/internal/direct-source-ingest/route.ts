import { getD1 } from "../../../../db";

type PaymentProtocol = "mpp" | "x402";
type MeasurementUnit = "protocol_payment" | "onchain_settlement" | "settlement_transfer";
type EvidenceLevel = "verified" | "deterministic" | "declared" | "inferred";
type SourceType = "chain_rpc" | "chain_sql" | "protocol_receipt" | "merchant_export";

type MetricInput = {
  activityDate?: unknown;
  measurementUnit?: unknown;
  transactionCount?: unknown;
  chargeCount?: unknown;
  sessionCount?: unknown;
  settlementCount?: unknown;
  rawTransferCount?: unknown;
  volumeUsdMicros?: unknown;
  recipientVolumeUsdMicros?: unknown;
  grossVolumeUsdMicros?: unknown;
  chargeVolumeUsdMicros?: unknown;
  sessionVolumeUsdMicros?: unknown;
  buyerCount?: unknown;
  sellerCount?: unknown;
  evidenceLevel?: unknown;
  isAdjusted?: unknown;
  limitation?: unknown;
};

type WindowMetricInput = MetricInput & {
  rangeStart?: unknown;
  rangeEnd?: unknown;
};

type CoverageInput = {
  measurementUnit?: unknown;
  sourceType?: unknown;
  sourceUrl?: unknown;
  coverageStart?: unknown;
  coverageEnd?: unknown;
  status?: unknown;
  limitation?: unknown;
  methodologyUrl?: unknown;
};

type IngestionBody = {
  sourceKey?: unknown;
  runKey?: unknown;
  protocol?: unknown;
  network?: unknown;
  collectorVersion?: unknown;
  rangeStart?: unknown;
  rangeEnd?: unknown;
  queryHash?: unknown;
  inputRowCount?: unknown;
  metrics?: unknown;
  windowSummary?: unknown;
  coverage?: unknown;
};

type ExistingRun = {
  id: string;
  query_hash: string;
  status: "importing" | "complete" | "failed" | "superseded";
  metric_row_count: number;
};

const PROTOCOLS = new Set<PaymentProtocol>(["mpp", "x402"]);
const MEASUREMENT_UNITS = new Set<MeasurementUnit>([
  "protocol_payment",
  "onchain_settlement",
  "settlement_transfer",
]);
const EVIDENCE_LEVELS = new Set<EvidenceLevel>([
  "verified",
  "deterministic",
  "declared",
  "inferred",
]);
const SOURCE_TYPES = new Set<SourceType>([
  "chain_rpc",
  "chain_sql",
  "protocol_receipt",
  "merchant_export",
]);
const COVERAGE_STATUSES = new Set(["active", "backfilling", "degraded", "blocked"]);

async function sha256(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cleanKey(value: unknown, field: string, maximum = 180) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const clean = value.trim();
  if (clean.length > maximum || !/^[a-zA-Z0-9:._/-]+$/.test(clean)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return clean;
}

function cleanText(value: unknown, field: string, maximum = 1_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const clean = value.trim();
  if (clean.length > maximum) throw new Error(`${field} is too long.`);
  return clean;
}

function optionalText(value: unknown, field: string, maximum = 1_000) {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, field, maximum);
}

function isoTimestamp(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 86_400_000) {
    throw new Error(`${field} is invalid.`);
  }
  return date.toISOString();
}

function activityDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Metric activityDate must be YYYY-MM-DD.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Metric activityDate is invalid.");
  }
  return value;
}

function count(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function optionalCount(value: unknown, field: string) {
  return value === undefined || value === null ? 0 : count(value, field);
}

function sourceUrl(value: unknown, field: string) {
  const clean = cleanText(value, field, 500);
  const parsed = new URL(clean);
  if (parsed.protocol !== "https:") throw new Error(`${field} must use HTTPS.`);
  return parsed.toString();
}

function parseMetric(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Every metric must be an object.");
  const metric = value as MetricInput;
  const measurementUnit = MEASUREMENT_UNITS.has(metric.measurementUnit as MeasurementUnit)
    ? (metric.measurementUnit as MeasurementUnit)
    : null;
  const evidenceLevel = EVIDENCE_LEVELS.has(metric.evidenceLevel as EvidenceLevel)
    ? (metric.evidenceLevel as EvidenceLevel)
    : null;
  if (!measurementUnit) throw new Error("Metric measurementUnit is invalid.");
  if (!evidenceLevel) throw new Error("Metric evidenceLevel is invalid.");
  if (typeof metric.isAdjusted !== "boolean") throw new Error("Metric isAdjusted is required.");
  return {
    activityDate: activityDate(metric.activityDate),
    measurementUnit,
    transactionCount: count(metric.transactionCount, "Transaction count"),
    chargeCount: optionalCount(metric.chargeCount, "Charge count"),
    sessionCount: optionalCount(metric.sessionCount, "Session count"),
    settlementCount: count(metric.settlementCount, "Settlement count"),
    rawTransferCount: optionalCount(metric.rawTransferCount, "Raw transfer count"),
    volumeUsdMicros: count(metric.volumeUsdMicros, "USD volume micros"),
    recipientVolumeUsdMicros:
      metric.recipientVolumeUsdMicros === undefined || metric.recipientVolumeUsdMicros === null
        ? count(metric.volumeUsdMicros, "USD volume micros")
        : count(metric.recipientVolumeUsdMicros, "Recipient USD volume micros"),
    grossVolumeUsdMicros:
      metric.grossVolumeUsdMicros === undefined || metric.grossVolumeUsdMicros === null
        ? count(metric.volumeUsdMicros, "USD volume micros")
        : count(metric.grossVolumeUsdMicros, "Gross USD volume micros"),
    chargeVolumeUsdMicros: optionalCount(
      metric.chargeVolumeUsdMicros,
      "Charge USD volume micros",
    ),
    sessionVolumeUsdMicros: optionalCount(
      metric.sessionVolumeUsdMicros,
      "Session USD volume micros",
    ),
    buyerCount: count(metric.buyerCount, "Buyer count"),
    sellerCount: count(metric.sellerCount, "Seller count"),
    evidenceLevel,
    isAdjusted: metric.isAdjusted,
    limitation: optionalText(metric.limitation, "Metric limitation", 2_000),
  };
}

function parseWindowMetric(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Window summary is required.");
  const metric = value as WindowMetricInput;
  const parsed = parseMetric({ ...metric, activityDate: "2000-01-01" });
  const rangeStart = isoTimestamp(metric.rangeStart, "Window range start");
  const rangeEnd = isoTimestamp(metric.rangeEnd, "Window range end");
  if (rangeEnd <= rangeStart) throw new Error("Window range end must be after its start.");
  return {
    rangeStart,
    rangeEnd,
    measurementUnit: parsed.measurementUnit,
    transactionCount: parsed.transactionCount,
    chargeCount: parsed.chargeCount,
    sessionCount: parsed.sessionCount,
    settlementCount: parsed.settlementCount,
    rawTransferCount: parsed.rawTransferCount,
    volumeUsdMicros: parsed.volumeUsdMicros,
    recipientVolumeUsdMicros: parsed.recipientVolumeUsdMicros,
    grossVolumeUsdMicros: parsed.grossVolumeUsdMicros,
    chargeVolumeUsdMicros: parsed.chargeVolumeUsdMicros,
    sessionVolumeUsdMicros: parsed.sessionVolumeUsdMicros,
    buyerCount: parsed.buyerCount,
    sellerCount: parsed.sellerCount,
    evidenceLevel: parsed.evidenceLevel,
    isAdjusted: parsed.isAdjusted,
    limitation: parsed.limitation,
  };
}

function parseCoverage(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Coverage is required.");
  const coverage = value as CoverageInput;
  const measurementUnit = MEASUREMENT_UNITS.has(coverage.measurementUnit as MeasurementUnit)
    ? (coverage.measurementUnit as MeasurementUnit)
    : null;
  const sourceType = SOURCE_TYPES.has(coverage.sourceType as SourceType)
    ? (coverage.sourceType as SourceType)
    : null;
  if (!measurementUnit) throw new Error("Coverage measurementUnit is invalid.");
  if (!sourceType) throw new Error("Coverage sourceType is invalid.");
  if (!COVERAGE_STATUSES.has(coverage.status as string)) {
    throw new Error("Coverage status is invalid.");
  }
  return {
    measurementUnit,
    sourceType,
    sourceUrl: sourceUrl(coverage.sourceUrl, "Coverage source URL"),
    coverageStart:
      coverage.coverageStart === undefined || coverage.coverageStart === null
        ? null
        : isoTimestamp(coverage.coverageStart, "Coverage start"),
    coverageEnd:
      coverage.coverageEnd === undefined || coverage.coverageEnd === null
        ? null
        : isoTimestamp(coverage.coverageEnd, "Coverage end"),
    status: coverage.status as "active" | "backfilling" | "degraded" | "blocked",
    limitation: cleanText(coverage.limitation, "Coverage limitation", 2_000),
    methodologyUrl: sourceUrl(coverage.methodologyUrl, "Methodology URL"),
  };
}

async function ingestionToken() {
  const { env } = await import("cloudflare:workers");
  return (env as unknown as { DIRECT_SOURCE_INGEST_TOKEN?: string }).DIRECT_SOURCE_INGEST_TOKEN;
}

async function authorized(request: Request) {
  const expected = await ingestionToken();
  if (!expected) return { ok: false, configured: false };
  return {
    ok: request.headers.get("authorization") === `Bearer ${expected}`,
    configured: true,
  };
}

export async function GET() {
  return Response.json(
    {
      endpoint: "/api/internal/direct-source-ingest",
      method: "POST",
      authentication: "Bearer direct-source ingestion secret required",
      stores: ["immutable source runs", "daily protocol aggregates", "coverage boundaries"],
      policy: "Raw third-party scan totals are not accepted as primary evidence.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const auth = await authorized(request);
  if (!auth.configured) {
    return Response.json({ error: "Direct-source ingestion is not configured." }, { status: 503 });
  }
  if (!auth.ok) return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const body = (await request.json()) as IngestionBody;
    const sourceKey = cleanKey(body.sourceKey, "Source key", 120);
    const runKey = cleanKey(body.runKey, "Run key");
    const protocol = PROTOCOLS.has(body.protocol as PaymentProtocol)
      ? (body.protocol as PaymentProtocol)
      : null;
    if (!protocol) throw new Error("Protocol must be MPP or x402.");
    const network = cleanKey(body.network, "Network", 100).toLowerCase();
    const collectorVersion = cleanKey(body.collectorVersion, "Collector version", 80);
    const rangeStart = isoTimestamp(body.rangeStart, "Range start");
    const rangeEnd = isoTimestamp(body.rangeEnd, "Range end");
    if (rangeEnd <= rangeStart) throw new Error("Range end must be after range start.");
    const queryHash = cleanKey(body.queryHash, "Query hash", 128).toLowerCase();
    const inputRowCount = count(body.inputRowCount, "Input row count");
    if (!Array.isArray(body.metrics) || body.metrics.length < 1 || body.metrics.length > 400) {
      throw new Error("Each run must include between 1 and 400 daily metric rows.");
    }
    const metrics = body.metrics.map(parseMetric);
    const windowSummary = parseWindowMetric(body.windowSummary);
    const metricKeys = new Set(metrics.map((metric) => `${metric.activityDate}|${metric.measurementUnit}`));
    if (metricKeys.size !== metrics.length) {
      throw new Error("A run cannot contain duplicate date and measurement-unit rows.");
    }
    const coverage = parseCoverage(body.coverage);
    if (metrics.some((metric) => metric.measurementUnit !== coverage.measurementUnit)) {
      throw new Error("Every metric must use the coverage measurement unit.");
    }
    if (windowSummary.measurementUnit !== coverage.measurementUnit) {
      throw new Error("The window summary must use the coverage measurement unit.");
    }
    if (windowSummary.rangeStart !== rangeStart || windowSummary.rangeEnd !== rangeEnd) {
      throw new Error("The window summary range must match the ingestion range.");
    }

    const runId = await sha256(`${sourceKey}|${runKey}`);
    const d1 = await getD1();
    const existing = await d1
      .prepare(
        `SELECT id, query_hash, status, metric_row_count
         FROM source_ingestion_runs WHERE id = ?`,
      )
      .bind(runId)
      .first<ExistingRun>();
    if (existing?.status === "complete") {
      if (existing.query_hash !== queryHash) {
        return Response.json(
          { error: "This immutable run key already exists with a different query hash." },
          { status: 409 },
        );
      }
      return Response.json({
        runId,
        status: "complete",
        idempotentReplay: true,
        metricRows: existing.metric_row_count,
      });
    }
    if (existing && existing.query_hash !== queryHash) {
      return Response.json(
        { error: "An incomplete run with this key has a different query hash." },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    if (existing) {
      await d1
        .prepare("DELETE FROM daily_protocol_metrics WHERE run_id = ?")
        .bind(runId)
        .run();
      await d1
        .prepare("DELETE FROM protocol_window_metrics WHERE run_id = ?")
        .bind(runId)
        .run();
      await d1
        .prepare(
          `UPDATE source_ingestion_runs
           SET status = 'importing', error_message = NULL, completed_at = NULL,
               input_row_count = ?, metric_row_count = 0
           WHERE id = ?`,
        )
        .bind(inputRowCount, runId)
        .run();
    } else {
      await d1
        .prepare(
          `INSERT INTO source_ingestion_runs
           (id, source_key, protocol, network, collector_version, range_start, range_end,
            query_hash, input_row_count, metric_row_count, status, started_at,
            completed_at, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'importing', ?, NULL, NULL)`,
        )
        .bind(
          runId,
          sourceKey,
          protocol,
          network,
          collectorVersion,
          rangeStart,
          rangeEnd,
          queryHash,
          inputRowCount,
          now,
        )
        .run();
    }

    for (let index = 0; index < metrics.length; index += 50) {
      const statements = await Promise.all(
        metrics.slice(index, index + 50).map(async (metric) => {
          const id = await sha256(
            [runId, metric.activityDate, metric.measurementUnit].join("|"),
          );
          return d1
            .prepare(
              `INSERT INTO daily_protocol_metrics
               (id, run_id, source_key, protocol, network, activity_date, measurement_unit,
                transaction_count, charge_count, session_count, settlement_count, raw_transfer_count,
                volume_usd_micros, recipient_volume_usd_micros, gross_volume_usd_micros,
                charge_volume_usd_micros, session_volume_usd_micros,
                buyer_count, seller_count, evidence_level, is_adjusted, limitation,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(run_id, activity_date, measurement_unit)
               DO UPDATE SET run_id = excluded.run_id,
                 transaction_count = excluded.transaction_count,
                 charge_count = excluded.charge_count,
                 session_count = excluded.session_count,
                 settlement_count = excluded.settlement_count,
                 raw_transfer_count = excluded.raw_transfer_count,
                 volume_usd_micros = excluded.volume_usd_micros,
                 recipient_volume_usd_micros = excluded.recipient_volume_usd_micros,
                 gross_volume_usd_micros = excluded.gross_volume_usd_micros,
                 charge_volume_usd_micros = excluded.charge_volume_usd_micros,
                 session_volume_usd_micros = excluded.session_volume_usd_micros,
                 buyer_count = excluded.buyer_count,
                 seller_count = excluded.seller_count,
                 evidence_level = excluded.evidence_level,
                 is_adjusted = excluded.is_adjusted,
                 limitation = excluded.limitation,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              id,
              runId,
              sourceKey,
              protocol,
              network,
              metric.activityDate,
              metric.measurementUnit,
              metric.transactionCount,
              metric.chargeCount,
              metric.sessionCount,
              metric.settlementCount,
              metric.rawTransferCount,
              metric.volumeUsdMicros,
              metric.recipientVolumeUsdMicros,
              metric.grossVolumeUsdMicros,
              metric.chargeVolumeUsdMicros,
              metric.sessionVolumeUsdMicros,
              metric.buyerCount,
              metric.sellerCount,
              metric.evidenceLevel,
              metric.isAdjusted ? 1 : 0,
              metric.limitation,
              now,
              now,
            );
        }),
      );
      await d1.batch(statements);
    }

    const windowId = await sha256(
      [
        sourceKey,
        protocol,
        network,
        windowSummary.rangeStart,
        windowSummary.rangeEnd,
        windowSummary.measurementUnit,
      ].join("|"),
    );
    await d1
      .prepare(
        `INSERT INTO protocol_window_metrics
         (id, run_id, source_key, protocol, network, range_start, range_end,
          measurement_unit, transaction_count, charge_count, session_count,
          settlement_count, raw_transfer_count, volume_usd_micros,
          recipient_volume_usd_micros, gross_volume_usd_micros, charge_volume_usd_micros,
          session_volume_usd_micros, buyer_count, seller_count, evidence_level,
          is_adjusted, limitation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key, protocol, network, range_start, range_end, measurement_unit)
         DO UPDATE SET run_id = excluded.run_id,
           transaction_count = excluded.transaction_count,
           charge_count = excluded.charge_count,
           session_count = excluded.session_count,
           settlement_count = excluded.settlement_count,
           raw_transfer_count = excluded.raw_transfer_count,
           volume_usd_micros = excluded.volume_usd_micros,
           recipient_volume_usd_micros = excluded.recipient_volume_usd_micros,
           gross_volume_usd_micros = excluded.gross_volume_usd_micros,
           charge_volume_usd_micros = excluded.charge_volume_usd_micros,
           session_volume_usd_micros = excluded.session_volume_usd_micros,
           buyer_count = excluded.buyer_count,
           seller_count = excluded.seller_count,
           evidence_level = excluded.evidence_level,
           is_adjusted = excluded.is_adjusted,
           limitation = excluded.limitation,
           updated_at = excluded.updated_at`,
      )
      .bind(
        windowId,
        runId,
        sourceKey,
        protocol,
        network,
        windowSummary.rangeStart,
        windowSummary.rangeEnd,
        windowSummary.measurementUnit,
        windowSummary.transactionCount,
        windowSummary.chargeCount,
        windowSummary.sessionCount,
        windowSummary.settlementCount,
        windowSummary.rawTransferCount,
        windowSummary.volumeUsdMicros,
        windowSummary.recipientVolumeUsdMicros,
        windowSummary.grossVolumeUsdMicros,
        windowSummary.chargeVolumeUsdMicros,
        windowSummary.sessionVolumeUsdMicros,
        windowSummary.buyerCount,
        windowSummary.sellerCount,
        windowSummary.evidenceLevel,
        windowSummary.isAdjusted ? 1 : 0,
        windowSummary.limitation,
        now,
        now,
      )
      .run();

    const coverageId = await sha256(
      [sourceKey, protocol, network, coverage.measurementUnit].join("|"),
    );
    await d1
      .prepare(
        `INSERT INTO source_coverage
         (id, source_key, protocol, network, measurement_unit, source_type, source_url,
          coverage_start, coverage_end, last_successful_sync_at, status, limitation,
          methodology_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key, protocol, network, measurement_unit)
         DO UPDATE SET source_type = excluded.source_type,
           source_url = excluded.source_url,
           coverage_start = CASE
             WHEN source_coverage.coverage_start IS NULL THEN excluded.coverage_start
             WHEN excluded.coverage_start IS NULL THEN source_coverage.coverage_start
             WHEN excluded.coverage_start < source_coverage.coverage_start THEN excluded.coverage_start
             ELSE source_coverage.coverage_start
           END,
           coverage_end = CASE
             WHEN source_coverage.coverage_end IS NULL THEN excluded.coverage_end
             WHEN excluded.coverage_end IS NULL THEN source_coverage.coverage_end
             WHEN excluded.coverage_end > source_coverage.coverage_end THEN excluded.coverage_end
             ELSE source_coverage.coverage_end
           END,
           last_successful_sync_at = excluded.last_successful_sync_at,
           status = CASE
             WHEN source_coverage.coverage_end IS NULL OR excluded.coverage_end >= source_coverage.coverage_end
               THEN excluded.status
             ELSE source_coverage.status
           END,
           limitation = excluded.limitation,
           methodology_url = excluded.methodology_url,
           updated_at = excluded.updated_at`,
      )
      .bind(
        coverageId,
        sourceKey,
        protocol,
        network,
        coverage.measurementUnit,
        coverage.sourceType,
        coverage.sourceUrl,
        coverage.coverageStart,
        coverage.coverageEnd,
        now,
        coverage.status,
        coverage.limitation,
        coverage.methodologyUrl,
        now,
      )
      .run();

    await d1
      .prepare(
        `UPDATE source_ingestion_runs
         SET status = 'complete', metric_row_count = ?, completed_at = ?
         WHERE id = ?`,
      )
      .bind(metrics.length, now, runId)
      .run();

    return Response.json(
      {
        runId,
        status: "complete",
        metricRows: metrics.length,
        windowMetricRows: 1,
        coverage: coverage.status,
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Direct-source ingestion failed." },
      { status: 400 },
    );
  }
}
