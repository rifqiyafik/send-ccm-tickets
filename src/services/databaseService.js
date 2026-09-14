import pg from "pg";
import { createLogger } from "../utils/logger.js";

const { Pool } = pg;
const logger = createLogger("databaseService");

let defaultPool = null;

// memeriksa apakah variabel koneksi database PostgreSQL sudah terkonfigurasi di environment
export function isDatabaseConfigured() {
  return Boolean(
    process.env.PG_HOST &&
      process.env.PG_DATABASE &&
      (process.env.PG_USER || process.env.PG_PASSWORD)
  );
}

// mendapatkan konfigurasi koneksi database dari parameter atau environment
export function getDatabaseConfig(options = {}) {
  const host = options.host || process.env.PG_HOST || "localhost";
  const port = Number(options.port || process.env.PG_PORT || 5432);
  const database = options.database || process.env.PG_DATABASE || "postgres";
  const user = options.user || process.env.PG_USER || "postgres";
  const password = options.password || process.env.PG_PASSWORD || "";
  const schema = options.schema || process.env.PG_SCHEMA || "SQA_SUMBAGUT";
  const timeoutMs = Number(options.timeoutMs || process.env.PG_TIMEOUT_MS || 30000);
  const ssl =
    options.ssl !== undefined
      ? options.ssl
      : process.env.PG_SSL === "true"
      ? { rejectUnauthorized: false }
      : false;

  return {
    host,
    port,
    database,
    user,
    password,
    schema,
    timeoutMs,
    ssl,
  };
}

// membuat atau mengembalikan instance connection pool PostgreSQL
export function getDatabasePool(options = {}) {
  if (defaultPool && !options.forceNew) {
    return defaultPool;
  }

  const config = getDatabaseConfig(options);
  logger.info("Initializing PostgreSQL database pool", {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    schema: config.schema,
    ssl: Boolean(config.ssl),
  });

  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    connectionTimeoutMillis: config.timeoutMs,
    idleTimeoutMillis: 30000,
    max: 10,
  });

  pool.on("error", (err) => {
    logger.error("Unexpected error on idle PostgreSQL client", {
      message: err.message,
    });
  });

  if (!options.forceNew) {
    defaultPool = pool;
  }

  return pool;
}

// menjalankan query SQL dengan parameter binding
export async function queryDatabase(sql, params = [], customPool = null) {
  const pool = customPool || getDatabasePool();
  const startTime = Date.now();

  try {
    const result = await pool.query(sql, params);
    const durationMs = Date.now() - startTime;
    logger.debug("Executed database query", {
      rowCount: result.rowCount,
      durationMs,
    });
    return result;
  } catch (error) {
    logger.error("Database query failed", {
      message: error.message,
      sql: sql.slice(0, 160),
    });
    throw error;
  }
}

// memeriksa kesehatan koneksi ke PostgreSQL
export async function pingDatabase(customPool = null) {
  try {
    const result = await queryDatabase("SELECT 1 as ping", [], customPool);
    const ok = result.rows && result.rows.length > 0;
    logger.info("Database ping check", { ok });
    return { ok, success: true };
  } catch (error) {
    logger.error("Database ping failed", { message: error.message });
    return { ok: false, error: error.message };
  }
}

// menutup koneksi pool saat aplikasi shutdown
export async function closeDatabasePool(customPool = null) {
  const pool = customPool || defaultPool;
  if (pool) {
    logger.info("Closing PostgreSQL database pool");
    await pool.end();
    if (!customPool || pool === defaultPool) {
      defaultPool = null;
    }
  }
}
