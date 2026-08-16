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

export const cohortSnapshotRuns = sqliteTable(
  "cohort_snapshot_runs",
  {
    id: text("id").primaryKey(),
    protocol: text("protocol", { enum: ["all", "mpp", "x402"] }).notNull(),
    sourceKeysJson: text("source_keys_json").notNull(),
    coverageStart: text("coverage_start").notNull(),
    coverageEnd: text("coverage_end").notNull(),
    completeThrough: text("complete_through").notNull(),
    checksum: text("checksum").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    status: text("status", {
      enum: ["importing", "complete", "superseded"],
    })
      .notNull()
      .default("importing"),
    importedAt: text("imported_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("cohort_snapshot_protocol_checksum_unique").on(
      table.protocol,
      table.checksum,
    ),
    index("cohort_snapshot_protocol_status_idx").on(
      table.protocol,
      table.status,
      table.completeThrough,
    ),
  ],
);

export const cohortSnapshotCells = sqliteTable(
  "cohort_snapshot_cells",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => cohortSnapshotRuns.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["payer", "payee"] }).notNull(),
    mode: text("mode", { enum: ["activity", "acquisition"] }).notNull(),
    cohortMonth: text("cohort_month").notNull(),
    offset: integer("offset").notNull(),
    calendarMonth: text("calendar_month").notNull(),
    cohortSize: integer("cohort_size").notNull(),
    retained: integer("retained").notNull(),
    leftCensored: integer("left_censored", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("cohort_snapshot_cell_unique").on(
      table.runId,
      table.role,
      table.mode,
      table.cohortMonth,
      table.offset,
    ),
    index("cohort_snapshot_query_idx").on(
      table.runId,
      table.role,
      table.mode,
      table.cohortMonth,
    ),
  ],
);

export const publicRateLimits = sqliteTable(
  "public_rate_limits",
  {
    id: text("id").primaryKey(),
    route: text("route").notNull(),
    clientHash: text("client_hash").notNull(),
    windowStart: integer("window_start").notNull(),
    requestCount: integer("request_count").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("public_rate_limits_window_idx").on(table.route, table.windowStart),
  ],
);

export const sourceIngestionRuns = sqliteTable(
  "source_ingestion_runs",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    protocol: text("protocol", { enum: ["mpp", "x402"] }).notNull(),
    network: text("network").notNull(),
    collectorVersion: text("collector_version").notNull(),
    rangeStart: text("range_start").notNull(),
    rangeEnd: text("range_end").notNull(),
    queryHash: text("query_hash").notNull(),
    inputRowCount: integer("input_row_count").notNull().default(0),
    metricRowCount: integer("metric_row_count").notNull().default(0),
    status: text("status", {
      enum: ["importing", "complete", "failed", "superseded"],
    })
      .notNull()
      .default("importing"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("source_ingestion_runs_source_id_unique").on(table.sourceKey, table.id),
    index("source_ingestion_runs_protocol_range_idx").on(
      table.protocol,
      table.network,
      table.rangeStart,
      table.status,
    ),
  ],
);

export const dailyProtocolMetrics = sqliteTable(
  "daily_protocol_metrics",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => sourceIngestionRuns.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    protocol: text("protocol", { enum: ["mpp", "x402"] }).notNull(),
    network: text("network").notNull(),
    activityDate: text("activity_date").notNull(),
    measurementUnit: text("measurement_unit", {
      enum: ["protocol_payment", "onchain_settlement", "settlement_transfer"],
    }).notNull(),
    transactionCount: integer("transaction_count").notNull(),
    chargeCount: integer("charge_count").notNull().default(0),
    sessionCount: integer("session_count").notNull().default(0),
    settlementCount: integer("settlement_count").notNull(),
    rawTransferCount: integer("raw_transfer_count").notNull().default(0),
    volumeUsdMicros: integer("volume_usd_micros").notNull(),
    recipientVolumeUsdMicros: integer("recipient_volume_usd_micros").notNull().default(0),
    grossVolumeUsdMicros: integer("gross_volume_usd_micros").notNull().default(0),
    chargeVolumeUsdMicros: integer("charge_volume_usd_micros").notNull().default(0),
    sessionVolumeUsdMicros: integer("session_volume_usd_micros").notNull().default(0),
    buyerCount: integer("buyer_count").notNull(),
    sellerCount: integer("seller_count").notNull(),
    evidenceLevel: text("evidence_level", {
      enum: ["verified", "deterministic", "declared", "inferred"],
    }).notNull(),
    isAdjusted: integer("is_adjusted", { mode: "boolean" }).notNull().default(false),
    limitation: text("limitation"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("daily_protocol_metrics_run_date_unique").on(
      table.runId,
      table.activityDate,
      table.measurementUnit,
    ),
    index("daily_protocol_metrics_query_idx").on(
      table.protocol,
      table.network,
      table.activityDate,
      table.measurementUnit,
    ),
    index("daily_protocol_metrics_run_idx").on(table.runId),
  ],
);

export const protocolWindowMetrics = sqliteTable(
  "protocol_window_metrics",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => sourceIngestionRuns.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    protocol: text("protocol", { enum: ["mpp", "x402"] }).notNull(),
    network: text("network").notNull(),
    rangeStart: text("range_start").notNull(),
    rangeEnd: text("range_end").notNull(),
    measurementUnit: text("measurement_unit", {
      enum: ["protocol_payment", "onchain_settlement", "settlement_transfer"],
    }).notNull(),
    transactionCount: integer("transaction_count").notNull(),
    chargeCount: integer("charge_count").notNull().default(0),
    sessionCount: integer("session_count").notNull().default(0),
    settlementCount: integer("settlement_count").notNull(),
    rawTransferCount: integer("raw_transfer_count").notNull().default(0),
    volumeUsdMicros: integer("volume_usd_micros").notNull(),
    recipientVolumeUsdMicros: integer("recipient_volume_usd_micros").notNull().default(0),
    grossVolumeUsdMicros: integer("gross_volume_usd_micros").notNull().default(0),
    chargeVolumeUsdMicros: integer("charge_volume_usd_micros").notNull().default(0),
    sessionVolumeUsdMicros: integer("session_volume_usd_micros").notNull().default(0),
    buyerCount: integer("buyer_count").notNull(),
    sellerCount: integer("seller_count").notNull(),
    evidenceLevel: text("evidence_level", {
      enum: ["verified", "deterministic", "declared", "inferred"],
    }).notNull(),
    isAdjusted: integer("is_adjusted", { mode: "boolean" }).notNull().default(false),
    limitation: text("limitation"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("protocol_window_metrics_scope_unique").on(
      table.sourceKey,
      table.protocol,
      table.network,
      table.rangeStart,
      table.rangeEnd,
      table.measurementUnit,
    ),
    index("protocol_window_metrics_query_idx").on(
      table.protocol,
      table.network,
      table.rangeEnd,
      table.measurementUnit,
    ),
    index("protocol_window_metrics_run_idx").on(table.runId),
  ],
);

export const sourceCoverage = sqliteTable(
  "source_coverage",
  {
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    protocol: text("protocol", { enum: ["mpp", "x402"] }).notNull(),
    network: text("network").notNull(),
    measurementUnit: text("measurement_unit", {
      enum: ["protocol_payment", "onchain_settlement", "settlement_transfer"],
    }).notNull(),
    sourceType: text("source_type", {
      enum: ["chain_rpc", "chain_sql", "protocol_receipt", "merchant_export"],
    }).notNull(),
    sourceUrl: text("source_url").notNull(),
    coverageStart: text("coverage_start"),
    coverageEnd: text("coverage_end"),
    lastSuccessfulSyncAt: text("last_successful_sync_at"),
    status: text("status", {
      enum: ["active", "backfilling", "degraded", "blocked"],
    }).notNull(),
    limitation: text("limitation").notNull(),
    methodologyUrl: text("methodology_url").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("source_coverage_scope_unique").on(
      table.sourceKey,
      table.protocol,
      table.network,
      table.measurementUnit,
    ),
    index("source_coverage_protocol_idx").on(table.protocol, table.network, table.status),
  ],
);
