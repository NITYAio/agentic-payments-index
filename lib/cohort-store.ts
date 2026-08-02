import { getD1 } from "../db";
import {
  buildCohortMatrix,
  type CohortActivityRow,
  type CohortMatrix,
  type CohortRequest,
} from "./cohort-analysis";

type CoverageRow = {
  range_start: string | null;
  range_end: string | null;
};

type SourceRow = { source_key: string };

export async function loadCohortMatrix(
  request: CohortRequest,
  now = new Date(),
): Promise<CohortMatrix> {
  const d1 = await getD1();
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
