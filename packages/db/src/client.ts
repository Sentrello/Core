import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { dbSsl } from "./ssl";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const ssl = dbSsl();
const sql = postgres(url, { max: 10, ...(ssl ? { ssl } : {}) });
export const db = drizzle(sql, { schema });
export { schema };
