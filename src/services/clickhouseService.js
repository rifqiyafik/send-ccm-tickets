import https from "node:https";
import { createClient } from "@clickhouse/client";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("clickhouseService");

// filter region default untuk operasional tiket regional Sumbagut
export const DEFAULT_REGION_FILTER = "REGIONAL1";

// menyusun URL ClickHouse dari DB_HOST dan DB_PORT (mendukung format IP murni atau URL)
export function resolveClickHouseUrl(options = {}) {
  if (options.url) return options.url;

  const rawHost = String(
    options.host ||
      process.env.CLICKHOUSE_HOST ||
      process.env.DB_HOST ||
      "localhost",
  ).trim();
  const port = String(
    options.port ||
      process.env.CLICKHOUSE_PORT ||
      process.env.DB_PORT ||
      "9443",
  ).trim();

  // Jika host berupa JDBC ClickHouse URL (contoh: jdbc:clickhouse://10.37.159.112:9443/default)
  if (/^jdbc:clickhouse:\/\//i.test(rawHost)) {
    const stripped = rawHost.replace(/^jdbc:clickhouse:\/\//i, "https://");
    return stripped.replace(/\/$/, "");
  }

  // Jika host sudah mengandung skema http:// atau https://
  if (/^https?:\/\//i.test(rawHost)) {
    try {
      const parsed = new URL(rawHost);
      if (!parsed.port && port) {
        parsed.port = port;
      }
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return rawHost;
    }
  }

  // Jika host berupa IP murni atau hostname (contoh: 10.37.159.112)
  return `https://${rawHost}:${port}`;
}

// membuat instance client ClickHouse dengan konfigurasi dari environment
export function createClickHouseClient(options = {}) {
  const url = resolveClickHouseUrl(options);
  const database =
    options.database ||
    process.env.CLICKHOUSE_NAME ||
    process.env.DB_NAME ||
    "default";
  const username =
    options.username ||
    process.env.CLICKHOUSE_USER ||
    process.env.DB_USER ||
    "default";
  const password =
    options.password ||
    process.env.CLICKHOUSE_PASSWORD ||
    process.env.DB_PASSWORD ||
    "";
  const requestTimeout = Number(
    options.requestTimeout ||
      process.env.CLICKHOUSE_TIMEOUT_MS ||
      process.env.DB_TIMEOUT_MS ||
      30000,
  );
  const rejectUnauthorized =
    options.rejectUnauthorized ??
    process.env.DB_TLS_REJECT_UNAUTHORIZED === "true";

  logger.info("Initializing ClickHouse client", {
    url,
    database,
    username,
    requestTimeout,
    rejectUnauthorized,
  });

  let httpAgent = options.http_agent;
  if (!httpAgent && !rejectUnauthorized) {
    httpAgent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
    });
  }

  return createClient({
    url,
    database,
    username,
    password,
    request_timeout: requestTimeout,
    ...(httpAgent ? { http_agent: httpAgent } : {}),
  });
}

// memeriksa koneksi ke server ClickHouse
export async function pingClickHouse(client) {
  const ch = client || createClickHouseClient();
  try {
    const resultSet = await ch.query({
      query: "SELECT 1 as ping",
      format: "JSONEachRow",
    });
    await resultSet.json();
    logger.info("ClickHouse ping successful", { success: true });
    return { ok: true, success: true };
  } catch (error) {
    logger.error("ClickHouse ping failed", { message: error.message });
    return { ok: false, error: error.message };
  }
}

// menarik tiket L2 Assign running dari ClickHouse berdasarkan create_time >= sinceTime
export async function fetchRunningL2Tickets({
  client,
  sinceTime,
  region = DEFAULT_REGION_FILTER,
  limit = Number(process.env.DB_QUERY_LIMIT || 500),
} = {}) {
  const ch = client || createClickHouseClient();

  logger.info("Querying ClickHouse for running L2 tickets", {
    sinceTime,
    region,
    limit,
  });

  const query = `
    SELECT * 
    FROM "default".inap_ticketing_customer_complain FINAL 
    WHERE current_phase_name = 'L2 Assign' 
      AND customer_region_create_ticket = {region: String} 
      AND order_status = 'running'
      AND create_time >= {sinceTime: String}
    ORDER BY create_time ASC
    LIMIT {limit: UInt32}
  `;

  try {
    const resultSet = await ch.query({
      query,
      query_params: {
        region,
        sinceTime,
        limit,
      },
      format: "JSONEachRow",
    });

    const rows = await resultSet.json();
    logger.info("ClickHouse query completed", {
      rowCount: rows.length,
      sinceTime,
      region,
    });
    return rows;
  } catch (error) {
    logger.error("Failed to query ClickHouse for running L2 tickets", {
      sinceTime,
      region,
      message: error.message,
    });
    throw error;
  }
}
