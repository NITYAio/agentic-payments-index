import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const serviceSubmissions = sqliteTable("service_submissions", {
  id: text("id").primaryKey(),
  serviceName: text("service_name").notNull(),
  canonicalUrl: text("canonical_url").notNull().unique(),
  protocol: text("protocol", { enum: ["mpp", "x402", "both"] }).notNull(),
  network: text("network").notNull(),
  protocolEndpoint: text("protocol_endpoint").notNull(),
  contactEmail: text("contact_email").notNull(),
  challenge: text("challenge").notNull(),
  status: text("status", {
    enum: ["submitted", "reachable", "verified", "active", "inactive"],
  })
    .notNull()
    .default("submitted"),
  verificationMessage: text("verification_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  verifiedAt: text("verified_at"),
});

export const identityIngestionSegments = sqliteTable(
  "identity_ingestion_segments",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    protocol: text("protocol", { enum: ["mpp", "x402"] }).notNull(),
    network: text("network").notNull(),
    evidenceType: text("evidence_type", {
      enum: [
        "mpp_receipt",
        "x402_settlement",
        "confirmed_chain",
        "service_export",
      ],
    }).notNull(),
    cursorStart: text("cursor_start"),
    cursorEnd: text("cursor_end"),
    rangeStart: text("range_start").notNull(),
    rangeEnd: text("range_end").notNull(),
    recordCount: integer("record_count").notNull(),
    activityRowCount: integer("activity_row_count").notNull().default(0),
    checksum: text("checksum").notNull(),
    status: text("status", {
      enum: ["importing", "complete", "superseded"],
    })
      .notNull()
      .default("importing"),
    importedAt: text("imported_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("identity_segments_source_id_unique").on(
      table.sourceKey,
      table.id,
    ),
    index("identity_segments_protocol_status_idx").on(
      table.protocol,
      table.status,
      table.rangeStart,
    ),
  ],
);

export const monthlyIdentityActivity = sqliteTable(
  "monthly_identity_activity",
  {
    id: text("id").primaryKey(),
    segmentId: text("segment_id")
      .notNull()
      .references(() => identityIngestionSegments.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["payer", "payee"] }).notNull(),
    protocol: text("protocol", { enum: ["mpp", "x402"] }).notNull(),
    network: text("network").notNull(),
    identityScheme: text("identity_scheme").notNull(),
    identityHash: text("identity_hash").notNull(),
    activityMonth: text("activity_month").notNull(),
    transactionCount: integer("transaction_count").notNull(),
    volumeUsdMicros: integer("volume_usd_micros").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    evidenceLevel: text("evidence_level", {
      enum: ["verified", "deterministic", "declared", "inferred"],
    }).notNull(),
  },
  (table) => [
    uniqueIndex("monthly_identity_segment_activity_unique").on(
      table.segmentId,
      table.role,
      table.protocol,
      table.network,
      table.identityHash,
      table.activityMonth,
      table.evidenceLevel,
    ),
    index("monthly_identity_cohort_idx").on(
      table.role,
      table.protocol,
      table.activityMonth,
      table.evidenceLevel,
    ),
    index("monthly_identity_history_idx").on(
      table.role,
      table.identityHash,
      table.activityMonth,
    ),
    index("monthly_identity_segment_idx").on(table.segmentId),
  ],
);
