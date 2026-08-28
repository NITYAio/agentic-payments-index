import { getD1 } from "../../../../db";
import { validateCohortSnapshot } from "../../../../lib/cohort-snapshot";

type ExistingRun = {
  id: string;
  checksum: string;
  status: "importing" | "complete" | "superseded";
  row_count: number;
};

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function ingestionToken() {
  const { env } = await import("cloudflare:workers");
  return (env as unknown as { IDENTITY_INGEST_TOKEN?: string }).IDENTITY_INGEST_TOKEN;
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
      endpoint: "/api/internal/cohort-snapshot-ingest",
      method: "POST",
      authentication: "Bearer identity-ingestion secret required",
      purpose:
        "Stores exact, precomputed retention cells without publishing or querying raw identity histories.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const auth = await authorized(request);
  if (!auth.configured) {
    return Response.json({ error: "Cohort ingestion is not configured." }, { status: 503 });
  }
  if (!auth.ok) return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const snapshot = validateCohortSnapshot(await request.json());
    const orderedCells = [...snapshot.cells].sort((left, right) =>
      [left.role, left.mode, left.cohortMonth, left.offset]
        .join("|")
        .localeCompare([right.role, right.mode, right.cohortMonth, right.offset].join("|")),
    );
    const checksum = await sha256(JSON.stringify({
      ...snapshot,
      cells: orderedCells,
    }));
    const runId = await sha256(
      [snapshot.protocol, snapshot.coverageStart, snapshot.coverageEnd, checksum].join("|"),
    );
    const d1 = await getD1();
    const existing = await d1
      .prepare(
        `SELECT id, checksum, status, row_count
         FROM cohort_snapshot_runs WHERE id = ?`,
      )
      .bind(runId)
      .first<ExistingRun>();
    if (existing?.status === "complete") {
      return Response.json({
        runId,
        protocol: snapshot.protocol,
        status: "complete",
        idempotentReplay: true,
        cells: existing.row_count,
      });
    }
    if (existing && existing.checksum !== checksum) {
      return Response.json(
        { error: "An incomplete snapshot with this id has different contents." },
        { status: 409 },
      );
    }

    const importedAt = new Date().toISOString();
    if (existing) {
      await d1.prepare("DELETE FROM cohort_snapshot_cells WHERE run_id = ?").bind(runId).run();
    } else {
      await d1
        .prepare(
          `INSERT INTO cohort_snapshot_runs
           (id, protocol, source_keys_json, coverage_start, coverage_end,
            complete_through, checksum, row_count, status, imported_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'importing', ?, NULL)`,
        )
        .bind(
          runId,
          snapshot.protocol,
          JSON.stringify(snapshot.sourceKeys),
          snapshot.coverageStart,
          snapshot.coverageEnd,
          snapshot.completeThrough,
          checksum,
          importedAt,
        )
        .run();
    }

    for (let index = 0; index < orderedCells.length; index += 75) {
      const statements = await Promise.all(
        orderedCells.slice(index, index + 75).map(async (cell) =>
          d1
            .prepare(
              `INSERT INTO cohort_snapshot_cells
               (id, run_id, role, mode, cohort_month, offset, calendar_month,
                cohort_size, retained, left_censored)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              await sha256(
                [runId, cell.role, cell.mode, cell.cohortMonth, cell.offset].join("|"),
              ),
              runId,
              cell.role,
              cell.mode,
              cell.cohortMonth,
              cell.offset,
              cell.calendarMonth,
              cell.cohortSize,
              cell.retained,
              cell.leftCensored ? 1 : 0,
            ),
        ),
      );
      await d1.batch(statements);
    }

    const completedAt = new Date().toISOString();
    await d1.batch([
      d1
        .prepare(
          `UPDATE cohort_snapshot_runs
           SET status = 'superseded'
           WHERE protocol = ? AND status = 'complete' AND id <> ?`,
        )
        .bind(snapshot.protocol, runId),
      d1
        .prepare(
          `UPDATE cohort_snapshot_runs
           SET status = 'complete', row_count = ?, completed_at = ?
           WHERE id = ?`,
        )
        .bind(orderedCells.length, completedAt, runId),
    ]);
    return Response.json(
      {
        runId,
        protocol: snapshot.protocol,
        status: "complete",
        cells: orderedCells.length,
        coverageStart: snapshot.coverageStart,
        coverageEnd: snapshot.coverageEnd,
        completeThrough: snapshot.completeThrough,
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Cohort ingestion failed." },
      { status: 400 },
    );
  }
}
