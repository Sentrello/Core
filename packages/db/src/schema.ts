import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// The tenant boundary. One row per self-hosted instance today; many rows in a
// future hosted cloud tier — no rewrite needed (Build Plan §6.1).
export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Cache of the last successfully verified license (for offline boots).
export const licenseCache = pgTable("license_cache", {
  id: integer("id").primaryKey().default(1), // singleton row
  tier: text("tier").notNull().default("free"),
  modules: jsonb("modules").$type<string[]>().notNull().default([]),
  token: text("token"),
  refreshedAt: timestamp("refreshed_at").defaultNow().notNull(),
});
