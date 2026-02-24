import postgres from "postgres";

let sql: ReturnType<typeof postgres> | null = null;

export function getDb(): ReturnType<typeof postgres> {
  if (sql) {
    return sql;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    sql = postgres(databaseUrl);
  } else {
    // Use individual environment variables
    sql = postgres({
      host: process.env.PGHOST || "localhost",
      port: parseInt(process.env.PGPORT || "5432", 10),
      user: process.env.PGUSER || "postgres",
      password: process.env.PGPASSWORD || "",
      database: process.env.PGDATABASE || "var_codemap",
    });
  }

  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

