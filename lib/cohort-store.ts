import { getD1 } from "../db";
import {
  buildCohortMatrix,
  monthFromIndex,
  monthIndex,
  type CohortActivityRow,
  type CohortCell,
  type CohortMatrix,
  type CohortRequest,
  type CohortRow,
} from "./cohort-analysis";

type CoverageRow = {
  range_start: string | null;
  range_end: string | null;
};

type SourceRow = { source_key: string };

const X402_TERMINAL_IDENTITY_SOURCES = [
  "identity:x402:base-usdc:cdp-sql:terminal-recipient-v1",
  "identity:x402:base-usdc:blockscout:terminal-recipient-v1",
  "identity:x402:base-usdc:rpc-trace:terminal-recipient-v1",
  "identity:x402:base-usdc:rpc-events:terminal-recipient-v1",
  "identity:x402:base-usdc:x402scan-index:terminal-recipient-v1",
  "identity:x402:base-usdc:substreams-pulse-v3.3.0",
] as const;

type SnapshotRunRow = {
  id: string;
  source_keys_json: string;
  coverage_start: string;
  coverage_end: string;
  complete_through: string;
};

type SnapshotCellRow = {
  cohort_month: string;
  offset: number;
  calendar_month: string;
  cohort_size: number;
  retained: number;
  left_censored: number;
};

function monthFromTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function definition(request: CohortRequest) {
  return request.mode === "acquisition"
    ? "An identity enters the cohort in its first observed active month and is retained when it pays again in a later month."
    : "An identity enters the cohort when it is active in the selected month and is retained when it pays again in a later month.";
}

function limitation(request: CohortRequest) {
  return request.protocol === "all"
    ? "Combined cohorts keep protocol and network identities separate; they are not cross-protocol deduplicated. The current partial month is excluded."
    : "Wallet or credential identities are not people; one actor can control several identities and several actors can share one. The current partial month is excluded.";
}

async function loadSnapshotMatrix(
  d1: Awaited<ReturnType<typeof getD1>>,
  request: CohortRequest,
) {
  const run = await d1
    .prepare(
      `SELECT id, source_keys_json, coverage_start, coverage_end, complete_through
       FROM cohort_snapshot_runs
       WHERE protocol = ? AND status = 'complete'
       ORDER BY complete_through DESC, completed_at DESC
       LIMIT 1`,
    )
    .bind(request.protocol)
    .first<SnapshotRunRow>();
  if (!run) return null;
  const result = await d1
    .prepare(
      `SELECT cohort_month, offset, calendar_month, cohort_size, retained, left_censored
       FROM cohort_snapshot_cells
       WHERE run_id = ? AND role = ? AND mode = ?
       ORDER BY cohort_month, offset`,
    )
    .bind(run.id, request.role, request.mode)
    .all<SnapshotCellRow>();
  const monthCount = Math.max(1, Math.min(24, Math.trunc(request.months)));
  const requestedMonths = request.cohortMonth
    ? new Set([request.cohortMonth])
    : new Set(
        Array.from({ length: monthCount }, (_, offset) =>
          monthFromIndex(monthIndex(run.complete_through) - monthCount + 1 + offset),
        ),
      );
  const grouped = new Map<string, CohortRow>();
  for (const cell of result.results) {
    if (!requestedMonths.has(cell.cohort_month)) continue;
    const row = grouped.get(cell.cohort_month) ?? {
      cohortMonth: cell.cohort_month,
      cohortSize: cell.cohort_size,
      cells: [],
      leftCensored: Boolean(cell.left_censored),
    };
    row.cells.push({
      offset: cell.offset,
      calendarMonth: cell.calendar_month,
      retained: cell.retained,
      rate: cell.cohort_size ? (cell.retained / cell.cohort_size) * 100 : 0,
    } satisfies CohortCell);
    grouped.set(cell.cohort_month, row);
  }
  const rows = [...grouped.values()].sort((left, right) =>
    left.cohortMonth.localeCompare(right.cohortMonth),
  );
  const columns = Array.from(
    { length: Math.max(0, ...rows.map((row) => row.cells.length)) },
    (_, offset) => offset,
  );
  let sources: string[] = [];
  try {
    const parsed = JSON.parse(run.source_keys_json);
    if (Array.isArray(parsed)) sources = parsed.filter((value) => typeof value === "string");
  } catch {
    sources = [];
  }
  return {
    available: rows.some((row) => row.cohortSize > 0),
    role: request.role,
    protocol: request.protocol,
    mode: request.mode,
    rows,
    columns,
    coverageStart: monthFromTimestamp(run.coverage_start),
    coverageEnd: monthFromTimestamp(run.coverage_end),
    completeThrough: run.complete_through,
    sources,
    definition: definition(request),
    limitation: limitation(request),
  } satisfies CohortMatrix;
}

export async function loadCohortMatrix(
  request: CohortRequest,
  now = new Date(),
): Promise<CohortMatrix> {
  const d1 = await getD1();
  const snapshot = await loadSnapshotMatrix(d1, request);
  if (snapshot) return snapshot;
  if (request.role === "payee" && request.protocol !== "mpp") {
    const correctedCoverage = await d1
      .prepare(
        `SELECT 1 AS available
         FROM identity_ingestion_segments
         WHERE source_key IN (?, ?, ?, ?, ?, ?) AND status = 'complete'
         LIMIT 1`,
      )
      .bind(...X402_TERMINAL_IDENTITY_SOURCES)
      .first<{ available: number }>();
    if (!correctedCoverage) {
      return {
        available: false,
        role: request.role,
        protocol: request.protocol,
        mode: request.mode,
        rows: [],
        columns: [],
        coverageStart: null,
        coverageEnd: null,
        completeThrough: null,
        sources: [],
        definition: definition(request),
        limitation:
          "x402 seller retention is temporarily unavailable while historical routing proxies are replaced with terminal recipient identities. MPP seller cohorts and payer cohorts remain available.",
      } satisfies CohortMatrix;
    }
  }
  const protocolClause = request.protocol === "all" ? "" : "AND a.protocol = ?";
  const segmentProtocolClause = request.protocol === "all" ? "" : "AND protocol = ?";
  const activityParameters =
    request.protocol === "all"
      ? [request.role]
      : [request.role, request.protocol];
  const coverageParameters =
    request.protocol === "all" ? [] : [request.protocol];
  const [activityResult, coverageResult, sourceResult] = await Promise.all([
    d1
      .prepare(
        `SELECT a.identity_hash AS identityHash, a.activity_month AS activityMonth
         FROM monthly_identity_activity a
         JOIN identity_ingestion_segments s ON s.id = a.segment_id
         WHERE a.role = ?
           AND s.status = 'complete'
           AND a.evidence_level IN ('verified', 'deterministic')
           ${protocolClause}
         GROUP BY a.identity_hash, a.activity_month`,
      )
      .bind(...activityParameters)
      .all<CohortActivityRow>(),
    d1
      .prepare(
        `SELECT MIN(range_start) AS range_start, MAX(range_end) AS range_end
         FROM identity_ingestion_segments
         WHERE status = 'complete' ${segmentProtocolClause}`,
      )
      .bind(...coverageParameters)
      .first<CoverageRow>(),
    d1
      .prepare(
        `SELECT DISTINCT source_key
         FROM identity_ingestion_segments
         WHERE status = 'complete' ${segmentProtocolClause}
         ORDER BY source_key`,
      )
      .bind(...coverageParameters)
      .all<SourceRow>(),
  ]);
  const coverage =
    coverageResult?.range_start && coverageResult.range_end
      ? {
          start: coverageResult.range_start,
          end: coverageResult.range_end,
          sources: sourceResult.results.map((row) => row.source_key),
        }
      : null;
  return buildCohortMatrix(activityResult.results, request, coverage, now);
}
