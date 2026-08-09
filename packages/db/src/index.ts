export * from "./client";
export * from "./schema";

/**
 * Query helpers re-exported from the host's drizzle instance.
 *
 * Modules must import these from here rather than depending on `drizzle-orm`
 * themselves: a second copy of the ORM in a module bundle produces structurally
 * identical but nominally incompatible types (and a second set of runtime
 * classes). One ORM per host.
 */
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
