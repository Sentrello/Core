/**
 * Drizzle's builders and query helpers, re-exported so modules never carry
 * their own copy of the ORM — a second copy gives structurally identical but
 * nominally incompatible types and a second set of runtime classes.
 *
 * This module deliberately does NOT touch `./client`: importing it must never
 * open a database connection. Schema files and migration tooling import from
 * here; anything that actually queries imports `db` from the package root.
 */
export {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
