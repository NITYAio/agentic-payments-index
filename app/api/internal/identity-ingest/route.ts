import { getD1 } from "../../../../db";
import {
  aggregateIdentityActivity,
  validateNormalizedEvent,
  type EvidenceType,
  type PaymentProtocol,
} from "../../../../lib/identity-data";

type IngestionBody = {
  sourceKey?: unknown;
  segmentKey?: unknown;
  protocol?: unknown;
  network?: unknown;
  evidenceType?: unknown;
  cursorStart?: unknown;
  cursorEnd?: unknown;
  events?: unknown;
};

type ExistingSegment = {
  id: string;
  checksum: string;
  status: "importing" | "complete" | "superseded";
  activity_row_count: number;
};

const EVIDENCE_TYPES = new Set<EvidenceType>([
  "mpp_receipt",
  "x402_settlement",
  "confirmed_chain",
  "service_export",
]);

async function sha256(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cleanKey(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const clean = value.trim();
  if (clean.length > maximum || !/^[a-zA-Z0-9:._/-]+$/.test(clean)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return clean;
}

function optionalCursor(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 240) throw new Error("Cursor is invalid.");
  return value;
}

async function ingestionToken() {
  const { env } = await import("cloudflare:workers");
  return (env as unknown as { IDENTITY_INGEST_TOKEN?: string }).IDENTITY_INGEST_TOKEN;
}

async function authorized(request: Request) {
  const expected = await ingestionToken();
  if (!expected) return { ok: false, configured: false };
  const supplied = request.headers.get("authorization");
  return { ok: supplied === `Bearer ${expected}`, configured: true };
}

export async function GET() {
  return Response.json(
    {
      endpoint: "/api/internal/identity-ingest",
      method: "POST",
      authentication: "Bearer ingestion secret required",
      accepts: ["MPP receipts", "x402 settlement responses", "confirmed-chain exports"],
      privacy: "Raw payer and payee identifiers are SHA-256 hashed before storage.",
      retention: "Only monthly identity activity and auditable ingestion segments are retained.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const auth = await authorized(request);
  if (!auth.configured) {
    return Response.json(
      { error: "Identity ingestion is not configured." },
      { status: 503 },
    );
  }
  if (!auth.ok) return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const body = (await request.json()) as IngestionBody;
    const sourceKey = cleanKey(body.sourceKey, "Source key", 120);
    const segmentKey = cleanKey(body.segmentKey, "Segment key", 180);
    const protocol =
      body.protocol === "mpp" || body.protocol === "x402"
        ? (body.protocol as PaymentProtocol)
        : null;
    if (!protocol) throw new Error("Protocol must be MPP or x402.");
    const network = cleanKey(body.network, "Network", 100).toLowerCase();
    const evidenceType = EVIDENCE_TYPES.has(body.evidenceType as EvidenceType)
      ? (body.evidenceType as EvidenceType)
      : null;
    if (!evidenceType) throw new Error("Evidence type is invalid.");
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 500) {
      throw new Error("Each ingestion segment must contain between 1 and 500 events.");
    }
    const events = body.events.map(validateNormalizedEvent);
    const eventIds = new Set(events.map((event) => event.id));
    if (eventIds.size !== events.length) throw new Error("Event ids must be unique within a segment.");
    if (events.some((event) => event.protocol !== protocol || event.network.toLowerCase() !== network)) {
      throw new Error("Every event must match the segment protocol and network.");
    }
    const timestamps = events.map((event) => new Date(event.occurredAt).toISOString()).sort();
    const rangeStart = timestamps[0];
    const rangeEnd = timestamps.at(-1)!;
    const segmentId = await sha256(`${sourceKey}|${segmentKey}`);
    const checksum = await sha256(
      events
        .map((event) =>
          [
            event.id,
            event.occurredAt,
            event.payer.scheme,
            event.payer.key,
            event.payee.scheme,
            event.payee.key,
            event.transactionCount ?? 1,
            event.volumeUsdMicros ?? 0,
            event.evidenceLevel,
          ].join("|"),
        )
        .sort()
        .join("\n"),
    );
    const d1 = await getD1();
    const existing = await d1
      .prepare(
        `SELECT id, checksum, status, activity_row_count
         FROM identity_ingestion_segments WHERE id = ?`,
      )
      .bind(segmentId)
      .first<ExistingSegment>();
    if (existing?.status === "complete") {
      if (existing.checksum !== checksum) {
        return Response.json(
          { error: "This immutable segment id was already imported with different contents." },
          { status: 409 },
        );
      }
      return Response.json({
        segmentId,
        status: "complete",
        idempotentReplay: true,
        activityRows: existing.activity_row_count,
      });
    }
    if (existing && existing.checksum !== checksum) {
      return Response.json(
        { error: "An incomplete segment with this id has different contents." },
        { status: 409 },
      );
    }
    const importedAt = new Date().toISOString();
    if (existing) {
      await d1
        .prepare("DELETE FROM monthly_identity_activity WHERE segment_id = ?")
        .bind(segmentId)
        .run();
    } else {
      await d1
        .prepare(
          `INSERT INTO identity_ingestion_segments
           (id, source_key, protocol, network, evidence_type, cursor_start, cursor_end,
            range_start, range_end, record_count, activity_row_count, checksum, status,
            imported_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'importing', ?, NULL)`,
        )
        .bind(
          segmentId,
          sourceKey,
          protocol,
          network,
          evidenceType,
          optionalCursor(body.cursorStart),
          optionalCursor(body.cursorEnd),
          rangeStart,
          rangeEnd,
          events.length,
          checksum,
          importedAt,
        )
        .run();
    }

    const activity = await aggregateIdentityActivity(segmentId, events);
    for (let index = 0; index < activity.length; index += 75) {
      const statements = activity.slice(index, index + 75).map((row) =>
        d1
          .prepare(
            `INSERT INTO monthly_identity_activity
             (id, segment_id, role, protocol, network, identity_scheme, identity_hash,
              activity_month, transaction_count, volume_usd_micros, first_seen_at,
              last_seen_at, evidence_level)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.segmentId,
            row.role,
            row.protocol,
            row.network,
            row.identityScheme,
            row.identityHash,
            row.activityMonth,
            row.transactionCount,
            row.volumeUsdMicros,
            row.firstSeenAt,
            row.lastSeenAt,
            row.evidenceLevel,
          ),
      );
      await d1.batch(statements);
    }
    const completedAt = new Date().toISOString();
    await d1
      .prepare(
        `UPDATE identity_ingestion_segments
         SET status = 'complete', activity_row_count = ?, completed_at = ?
         WHERE id = ?`,
      )
      .bind(activity.length, completedAt, segmentId)
      .run();
    return Response.json(
      {
        segmentId,
        status: "complete",
        events: events.length,
        activityRows: activity.length,
        rangeStart,
        rangeEnd,
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Identity ingestion failed." },
      { status: 400 },
    );
  }
}
