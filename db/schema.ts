import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
