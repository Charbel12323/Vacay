import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  var __subtrackerSql: ReturnType<typeof postgres> | undefined;
}

// Reuse the connection pool across Next.js hot reloads in dev.
const sql = globalThis.__subtrackerSql ?? postgres(env().DATABASE_URL, { max: 10 });
if (process.env.NODE_ENV !== "production") {
  globalThis.__subtrackerSql = sql;
}

export const db = drizzle(sql, { schema });
export { sql };
