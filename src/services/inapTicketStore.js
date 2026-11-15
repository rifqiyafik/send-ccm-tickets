import { queryDatabase, isDatabaseConfigured } from "./databaseService.js";
import { createLogger } from "../utils/logger.js";
import { cleanTableValue } from "../utils/text.js";
import { getWibDateString } from "../utils/dateTime.js";
import { shortenNopName } from "./ticketImportService.js";
import { resolveSiteFromTicketRow, resolveCityFromTicketRow } from "./siteSearchService.js";

const logger = createLogger("inapTicketStore");

const LOCAL_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Jakarta";
const DEFAULT_SCHEMA = process.env.PG_SCHEMA || "SQA_SUMBAGUT";
const MASTER_TABLE = process.env.PG_TABLE_TICKETS || "inap_ticketing_customer_complain";
const SENT_TABLE = process.env.PG_TABLE_SENT_HISTORY || "inap_sent_tickets_history";

// Daftar 8 grup L2 yang diizinkan untuk di-inject ke database inap_ticketing_customer_complain
export const ALLOWED_INJECT_ASSIGN_GROUPS = new Set([
  "group:Network Operations and Productivity Banda Aceh",
  "group:Network Operations and Productivity Aceh",
  "group:Network Operations and Productivity Binjai",
  "group:Network Operations and Productivity Medan",
  "group:Network Operations and Productivity Padang Sidempuan",
  "group:Network Operations and Productivity Pematangsiantar",
  "group:Network Operations and Productivity Rantau Prapat",
  "group:Service Quality Assurance Sumbagut",
]);

// Memeriksa apakah suatu assignment group termasuk dalam 8 grup L2 Sumbagut yang valid
export function isAllowedInjectAssignGroup(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed.toLowerCase() === "null") return false;
  if (ALLOWED_INJECT_ASSIGN_GROUPS.has(trimmed)) return true;

  const withGroup = trimmed.startsWith("group:") ? trimmed : `group:${trimmed}`;
  const lowerWithGroup = withGroup.toLowerCase();

  for (const allowed of ALLOWED_INJECT_ASSIGN_GROUPS) {
    if (allowed.toLowerCase() === lowerWithGroup) return true;
  }
  return false;
}

// mengonversi header Excel atau nama kolom mentah ke snake_case standar PostgreSQL
export function toSnakeCase(str) {
  if (!str) return "";
  let s = String(str)
    .replace(/[^a-zA-Z0-9]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
  s = s.replace(/_+/g, "_");
  s = s.replace(/^_+|_+$/g, "");
  return s;
}


// menghitung batas waktu H-1 pukul 00:00:00 WIB untuk window polling
export function getHMinusOneWatermark(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const yesterday = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = getWibDateString(yesterday);
  return `${dateStr} 00:00:00`;
}

// menentukan target eskalasi efektif untuk pencatatan di riwayat
export function resolveEffectiveTarget(ticket) {
  if (!ticket) return "";
  if (
    (ticket.is_repetitive ||
      ticket.targetGroupKey === "SITE VISIT" ||
      ticket.assignment_type === "SITE_VISIT") &&
    (ticket.assignment_type === "SQA" || ticket.assignment_type === "SITE_VISIT" || !ticket.assignment_type)
  ) {
    return "SITE VISIT";
  }
  if (ticket.assignment_type === "SQA") {
    return "SQA";
  }
  if (ticket.assignment_type === "NOP") {
    return shortenNopName(
      ticket.cluster_area ||
        ticket.nsa ||
        ticket.assignment_group ||
        "NOP",
    );
  }
  if (ticket.cluster_area || ticket.assignment_group) {
    return shortenNopName(ticket.cluster_area || ticket.assignment_group);
  }
  return "";
}

// mengonversi baris Excel ke object ber-key snake_case
export function convertRowToSnakeCase(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    const snake = toSnakeCase(key);
    if (snake) {
      result[snake] = value;
    }
  }
  return result;
}

// membersihkan nilai sel untuk tipe data non-TEXT di PostgreSQL
export function sanitizeCellValue(snakeKey, value) {
  if (value === null || value === undefined) return null;

  // Jika nilai adalah objek Date (misal diparsing dari cell date Excel)
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    if (snakeKey === "date") {
      return formatIsoDateOnly(value) || null;
    }
    if (snakeKey === "create_time") {
      return formatWibTimestamp(value) || null;
    }
    return formatWibTimestamp(value) || value.toISOString();
  }

  // Jika berupa Excel serial date (angka atau string float seperti '45961.9428')
  if (snakeKey === "date" || snakeKey === "create_time") {
    const serialDate = parseExcelSerialDate(value);
    if (serialDate) {
      if (snakeKey === "date") {
        return formatIsoDateOnly(serialDate) || null;
      }
      return formatWibTimestamp(serialDate) || null;
    }
  }

  const str = String(value).trim();
  const cleanStr = str.replace(/^'+/, "").trim();
  if (
    cleanStr === "" ||
    cleanStr === "-" ||
    cleanStr === "--" ||
    cleanStr.toLowerCase() === "null" ||
    cleanStr.toLowerCase() === "undefined"
  ) {
    return null;
  }

  // Jika kolom 'date', pastikan hanya format YYYY-MM-DD yang valid
  if (snakeKey === "date") {
    const d = formatIsoDateOnly(str);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  }

  // Jika kolom 'create_time', kembalikan format SQL Standard Timestamp lokal WIB (YYYY-MM-DD HH:mm:ss.000)
  if (snakeKey === "create_time") {
    return formatWibTimestamp(str);
  }

  // Tipe numerik atau koordinat (numeric di PostgreSQL)
  if (snakeKey === "latitude_l2_assign" || snakeKey === "longitude_l2_assign") {
    const normalizedStr = cleanStr.replace(/,/g, ".");
    const num = Number(normalizedStr);
    if (!Number.isFinite(num)) return null;
    // Hindari nilai anomali/overflow ekstrem jika ada data dummy
    if (Math.abs(num) > 1e12) return null;
    return num;
  }

  // Tipe integer (int4 di PostgreSQL)
  if (snakeKey === "reopen_number_confirm_close") {
    const normalized = cleanStr.replace(/,/g, ".");
    const num = Math.floor(Number(normalized));
    if (!Number.isFinite(num) || num < 0 || num > 2147483647) {
      return null;
    }
    return num;
  }

  return str;
}

// Daftar lengkap kolom valid tabel inap_ticketing_customer_complain (209 kolom)
export const MASTER_TABLE_COLUMNS = new Set([
  "date",
  "order_id",
  "agent_name",
  "agnostic_flag_create_ticket_agnostic_flag",
  "api_flag",
  "app_name",
  "assign_to",
  "assign_to_l2_l2_assign",
  "assign_to_l3",
  "assign_to_personal",
  "assign_personal_l2_l2_assign",
  "attachment_docman_create_ticket_attachmentdocman",
  "createtime_l1_assign",
  "assign_personal_l1_assign",
  "submittime_l1_assign",
  "createtime_l1_handle",
  "operator_l1_handle",
  "submittime_l1_handle",
  "createtime_l3_handle",
  "operator_l3_handle",
  "submittime_l3_handle",
  "createtime_l2_assign",
  "assign_personal_l2_assign",
  "submittime_l2_assign",
  "createtime_confirm_close",
  "operator_confirm_close",
  "submittime_confirm_close",
  "createtime_confirm_ticket",
  "operator_confirm_ticket",
  "submittime_confirm_ticket",
  "business_status",
  "cancel_reason",
  "cause",
  "does_smartcare_suggestion_helpful",
  "please_give_feedback_to_smartcare_l2_assign",
  "cch_suggestion_l1_assign_cch_suggestion",
  "cch_suggestion_2_l1_assign",
  "cch_suggestion_3_l1_assign",
  "cell_id_l2_assign_cell_id",
  "closed_timestamp_create_ticket",
  "complain_source_create_ticket",
  "complain_submitter_create_ticket",
  "complainer_name_create_ticket",
  "country_roaming_create_ticket",
  "create_time",
  "creator",
  "assign_to_l1_assign",
  "current_phase",
  "current_phase_name",
  "customer_create_ticket",
  "company_create_ticket",
  "customer_interaction_date_create_ticket",
  "customer_msisdn_create_ticket_customer_msisdn",
  "contact_create_ticket",
  "customer_region_create_ticket_customer_region",
  "customer_subtype_create_ticket_customer_subtype",
  "customer_type_create_ticket_customer_type",
  "demarcation_feedback_timestamp",
  "l1_assign",
  "description",
  "description_fault_sumptomps_create_ticket_description_fault_sym",
  "details_area_location_create_ticket_details_area_location",
  "end_time",
  "escalate",
  "l1_assign_escalate_timestamp",
  "exempt",
  "exempt_reason",
  "cell_id_l2_assign",
  "fault_cell_or_site2_l1_assign",
  "fault_cell_or_site3_l1_assign",
  "cch_hold_ticket",
  "gtx_complain_id_create_ticket_gtx_complain_id",
  "region_create_ticket",
  "country_name",
  "country_operator",
  "kabupaten_kota_create_ticket",
  "kecamatan_create_ticket",
  "desa_kelurahan_create_ticket",
  "last_update_time",
  "last_updater",
  "latitude_l2_assign",
  "longitude_l2_assign",
  "manual_create_create_ticket",
  "is_the_complain_a_roaming_type_create_ticket",
  "module_name",
  "nsd_attachment_1",
  "nsd_attachment_1_name",
  "ola_ctp",
  "ola_nsh",
  "ola_regional_create_ticket",
  "ola_status",
  "ola_target_time",
  "operation_mode",
  "operation_mode_confirm_close_operation_mode_confirm",
  "operation_mode_l1_assign_operation_mode_l1",
  "operation_mode_l2_assign_operation_mode_l2",
  "operation_mode_l3_assign_operation_mode_l3",
  "operator_roaming_create_ticket",
  "order_status",
  "order_seq",
  "parent_app_name",
  "parent_module_name",
  "parent_order_id",
  "parent_process_key",
  "parent_process_name",
  "parent_ticket_id",
  "pengaduan_create_ticket_pengaduan",
  "priority_l2_assign",
  "problem_analysis",
  "problem_start_time_create_ticket_problem_start_time",
  "process_key",
  "process_name",
  "process_type",
  "provinsi_create_ticket_provinsi",
  "resolution_l2_assign",
  "tier_1_create_ticket",
  "tier_2_create_ticket",
  "tier_3_create_ticket",
  "reassign_number_l2_assign",
  "remark_confirm_close",
  "reopen_number_confirm_close",
  "resolution",
  "resolution_attachment_1",
  "resolution_attachment_1_name",
  "resolution_attachment_2",
  "resolution_attachment_3",
  "resolution_categorization_tier_1",
  "resolution_categorization_tier_2",
  "resolution_categorization_tier_3",
  "l1_assign_resolved_timestamp",
  "resolution_categorization_tier_2_l1_assign",
  "role_project_name",
  "root_cause_tier_1_l1_assign",
  "root_caused_category_l2_assign",
  "root_caused_detail",
  "root_caused_others",
  "root_caused_tier_1_l2_assign",
  "root_caused_tier_2_l2_assign",
  "root_caused_tier_3_l2_assign",
  "root_caused_tier_4_l2_assign",
  "root_caused_tier_5_l2_assign",
  "root_caused_tier_6_l2_assign",
  "root_caused_tier_7_l2_assign",
  "root_caused_tier_8_l2_assign",
  "service_type_create_ticket",
  "tier_1_create_ticket_service_categorization_tier_1",
  "tier_2_create_ticket_service_categorization_tier_2",
  "tier_3_create_ticket_service_categorization_tier_3",
  "tier_4_create_ticket",
  "service_id_create_ticket_service_id",
  "site_id_l2_assign",
  "site_id2_l1_assign",
  "site_id3_l1_assign",
  "l1_assign_sla",
  "sla_paused",
  "sla_pausing",
  "sla_status",
  "sla_suspend_duration",
  "sla_suspend_reason",
  "sla_suspend_resume_time",
  "sla_suspend_status",
  "sla_target_time",
  "status_reason",
  "submitter_create_ticket_submitter",
  "subscription_brand_create_ticket_subscription_brand",
  "loyalty_create_ticket",
  "subscription_status_create_ticket_subscription_status",
  "subscription_sub_status_create_ticket_subscription_substatus",
  "subscription_type_create_ticket_subscription_type",
  "summary_create_ticket",
  "activity_notes",
  "ticket_id",
  "time_range_l1_assign_time_range",
  "timeframe_pelanggan_create_ticket",
  "title",
  "transactionid_create_ticket",
  "createtime_createtask",
  "operator_createtask",
  "submittime_createtask",
  "createtime_processtask",
  "operator_processtask",
  "submittime_processtask",
  "createtime_confirmtask",
  "operator_confirmtask",
  "submittime_confirmtask",
  "type_handset",
  "type_jaringan",
  "user_id_submitter_create_ticket_user_id_submitter",
  "vendor_ticket_number",
  "rc_tier_1_nsh",
  "rc_tier_2_nsh",
  "rc_tier_nsh",
  "rc_tier_4_nsh",
  "rc_tier_5_nsh",
  "rc_tier_6_nsh",
  "rc_tier_7_nsh",
  "rc_tier_8_nsh",
  "site_id_nsh",
  "rc_category_nsh",
  "root_caused_detail_nsh",
  "resolution_categorization_tier_1_l1_assign",
  "kode_post_c_create_ticket_kode_post_c",
  "resolution_categorization_tier_3_l1_assign",
  "rc_detail_cch",
  "rc_category_cch",
  "cch_automation_case",
  "problem_analysis_nsh",
  "site_id1_l1_assign",
  "fault_cell_or_site",
]);

// Pemetaan alias kolom shorthand ClickHouse / variasi nama kolom ke kolom schema PostgreSQL
export const CLICKHOUSE_TO_POSTGRES_COLUMN_MAP = Object.freeze({
  agnostic_flag: "agnostic_flag_create_ticket_agnostic_flag",
  attachmentdocman: "attachment_docman_create_ticket_attachmentdocman",
  attachment_docman: "attachment_docman_create_ticket_attachmentdocman",
  assign_to_l1: "assign_to_l1_assign",
  cch_suggestion: "cch_suggestion_l1_assign_cch_suggestion",
  cch_suggestion_l1_assign: "cch_suggestion_l1_assign_cch_suggestion",
  cch_suggestion_2: "cch_suggestion_2_l1_assign",
  cch_suggestion_3: "cch_suggestion_3_l1_assign",
  cell_id: "cell_id_l2_assign_cell_id",
  closed_timestamp: "closed_timestamp_create_ticket",
  complain_source: "complain_source_create_ticket",
  complain_submitter: "complain_submitter_create_ticket",
  complainer_name: "complainer_name_create_ticket",
  country_roaming: "country_roaming_create_ticket",
  customer: "customer_create_ticket",
  company: "company_create_ticket",
  customer_interaction_date: "customer_interaction_date_create_ticket",
  customer_msisdn: "customer_msisdn_create_ticket_customer_msisdn",
  customer_msisdn_create_ticket: "customer_msisdn_create_ticket_customer_msisdn",
  contact: "contact_create_ticket",
  customer_region: "customer_region_create_ticket_customer_region",
  customer_region_create_ticket: "customer_region_create_ticket_customer_region",
  customer_subtype: "customer_subtype_create_ticket_customer_subtype",
  customer_subtype_create_ticket: "customer_subtype_create_ticket_customer_subtype",
  customer_type: "customer_type_create_ticket_customer_type",
  customer_type_create_ticket: "customer_type_create_ticket_customer_type",
  description_fault_sumptomps:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_symptomps:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_symptoms:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_sumptomps_create_ticket:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_symptomps_create_ticket:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_symptoms_create_ticket:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_symptoms_create_ticket_description_fault_symptoms:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_sumptomps_create_ticket_description_fault_symptomps:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_symptoms_create_ticket_description_fault_sym:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_sumptomps_create_ticket_description_fault_sym:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_symptom:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  description_fault_sumptomp:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  fault_symptoms:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  fault_symptomps:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  fault_sumptomps:
    "description_fault_sumptomps_create_ticket_description_fault_sym",
  details_area_location:
    "details_area_location_create_ticket_details_area_location",
  details_area_location_create_ticket:
    "details_area_location_create_ticket_details_area_location",
  gtx_complain_id: "gtx_complain_id_create_ticket_gtx_complain_id",
  gtx_complain_id_create: "gtx_complain_id_create_ticket_gtx_complain_id",
  region: "region_create_ticket",
  kabupaten_kota: "kabupaten_kota_create_ticket",
  city: "kabupaten_kota_create_ticket",
  kecamatan: "kecamatan_create_ticket",
  desa_kelurahan: "desa_kelurahan_create_ticket",
  kelurahan: "desa_kelurahan_create_ticket",
  manual_create: "manual_create_create_ticket",
  is_the_complain_a_roaming_type:
    "is_the_complain_a_roaming_type_create_ticket",
  ola_regional: "ola_regional_create_ticket",
  operator_roaming: "operator_roaming_create_ticket",
  pengaduan: "pengaduan_create_ticket_pengaduan",
  problem_start_time: "problem_start_time_create_ticket_problem_start_time",
  problem_start_time_create_ticket:
    "problem_start_time_create_ticket_problem_start_time",
  provinsi: "provinsi_create_ticket_provinsi",
  tier_1: "tier_1_create_ticket",
  tier_1_create_ticket_service_categorization: "tier_1_create_ticket",
  tier_2: "tier_2_create_ticket",
  tier_2_create_ticket_service_categorization: "tier_2_create_ticket",
  tier_3: "tier_3_create_ticket",
  tier_3_create_ticket_service_categorization: "tier_3_create_ticket",
  tier_4: "tier_4_create_ticket",
  service_type: "service_type_create_ticket",
  service_id: "service_id_create_ticket_service_id",
  submitter: "submitter_create_ticket_submitter",
  subscription_brand: "subscription_brand_create_ticket_subscription_brand",
  loyalty: "loyalty_create_ticket",
  subscription_status:
    "subscription_status_create_ticket_subscription_status",
  subscription_sub_status:
    "subscription_sub_status_create_ticket_subscription_substatus",
  subscription_sub_status_create_ticket:
    "subscription_sub_status_create_ticket_subscription_substatus",
  subscription_type: "subscription_type_create_ticket_subscription_type",
  summary: "summary_create_ticket",
  timeframe_pelanggan: "timeframe_pelanggan_create_ticket",
  transactionid: "transactionid_create_ticket",
  user_id_submitter: "user_id_submitter_create_ticket_user_id_submitter",
  kode_post: "kode_post_c_create_ticket_kode_post_c",
  kode_post_c: "kode_post_c_create_ticket_kode_post_c",
  fault_cell_or_site_l1_assign: "fault_cell_or_site",
  fault_cell_or_site3: "fault_cell_or_site3_l1_assign",
  root_cause_tier_1: "root_cause_tier_1_l1_assign",
  root_caused_tier_7: "root_caused_tier_7_l2_assign",
  time_range: "time_range_l1_assign_time_range",
  site_id: "site_id1_l1_assign",
  site_id1: "site_id1_l1_assign",
  site_id_1: "site_id1_l1_assign",
  site_id_2: "site_id2_l1_assign",
  site_id2: "site_id2_l1_assign",
  site_id3: "site_id3_l1_assign",
  site_id_3: "site_id3_l1_assign",
  site_id_2_l2_assign: "site_id_l2_assign",
  assign_to_l2: "assign_to_l2_l2_assign",
  assignment_group: "assign_to_l2_l2_assign",
  assign_personal: "assign_personal_l2_assign",
  assign_personal_l2: "assign_personal_l2_assign",
  assign_personal_l1: "assign_personal_l1_assign",
  priority: "priority_l2_assign",
  resolution: "resolution_l2_assign",
  resolution_categorization_tier_2:
    "resolution_categorization_tier_2_l1_assign",
  reopen_number: "reopen_number_confirm_close",
  latitude: "latitude_l2_assign",
  longitude: "longitude_l2_assign",
  operation_mode_confirm_close:
    "operation_mode_confirm_close_operation_mode_confirm",
  operation_mode_l1_assign: "operation_mode_l1_assign_operation_mode_l1",
  operation_mode_l2_assign: "operation_mode_l2_assign_operation_mode_l2",
  operation_mode_l3_assign: "operation_mode_l3_assign_operation_mode_l3",
  time_range_l1_assign: "time_range_l1_assign_time_range",
  kabupaten_kota_create_ticket_kabupaten_kota: "kabupaten_kota_create_ticket",
  provinsi_create_ticket: "provinsi_create_ticket_provinsi",
  pengaduan_create_ticket: "pengaduan_create_ticket_pengaduan",
  service_id_create_ticket: "service_id_create_ticket_service_id",
  submitter_create_ticket: "submitter_create_ticket_submitter",
  subscription_brand_create_ticket:
    "subscription_brand_create_ticket_subscription_brand",
  subscription_status_create_ticket:
    "subscription_status_create_ticket_subscription_status",
  subscription_substatus_create_ticket:
    "subscription_sub_status_create_ticket_subscription_substatus",
  subscription_substatus:
    "subscription_sub_status_create_ticket_subscription_substatus",
  subscription_type_create_ticket:
    "subscription_type_create_ticket_subscription_type",
  user_id_submitter_create_ticket:
    "user_id_submitter_create_ticket_user_id_submitter",
  kode_post_c_create_ticket: "kode_post_c_create_ticket_kode_post_c",
});

let cachedMasterTableColumns = null;

// mengambil daftar kolom valid tabel master PostgreSQL (dinamis via information_schema dengan fallback ke MASTER_TABLE_COLUMNS)
export async function getValidMasterColumns(schema = DEFAULT_SCHEMA, table = MASTER_TABLE) {
  if (cachedMasterTableColumns && cachedMasterTableColumns.size > 0) {
    return cachedMasterTableColumns;
  }
  try {
    const res = await queryDatabase(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
      [schema, table],
    );
    if (res && res.rows && res.rows.length > 0) {
      cachedMasterTableColumns = new Set(
        res.rows.map((r) => r.column_name.toLowerCase()),
      );
      logger.info("Loaded master table columns from PostgreSQL schema", {
        count: cachedMasterTableColumns.size,
        table: `"${schema}".${table}`,
      });
      return cachedMasterTableColumns;
    }
  } catch (err) {
    logger.warn(
      "Could not query information_schema for master table columns, using static default columns",
      { error: err.message },
    );
  }
  return MASTER_TABLE_COLUMNS;
}

// memetakan row mentah (dari ClickHouse atau Excel) ke kolom-kolom valid PostgreSQL
export function mapMasterTicketRow(rawRow, validColumns = MASTER_TABLE_COLUMNS) {
  if (!rawRow || typeof rawRow !== "object") return {};
  const snakeRow = convertRowToSnakeCase(rawRow);
  const row = {};

  for (const [k, v] of Object.entries(snakeRow)) {
    let col = k;
    if (!validColumns.has(col) && CLICKHOUSE_TO_POSTGRES_COLUMN_MAP[col]) {
      col = CLICKHOUSE_TO_POSTGRES_COLUMN_MAP[col];
    }
    // Safeguard batasan 63 karakter identifier PostgreSQL
    if (!validColumns.has(col) && col.length > 63) {
      const truncated = col.slice(0, 63);
      if (validColumns.has(truncated)) {
        col = truncated;
      }
    }
    if (validColumns.has(col)) {
      if (
        row[col] === undefined ||
        row[col] === null ||
        String(row[col]).trim() === ""
      ) {
        row[col] = v;
      }
    }
  }

  if (snakeRow.order_id) {
    row.order_id = String(snakeRow.order_id).trim();
  }

  // Pastikan kolom 'date' terisi dan valid
  row.date = extractTicketDate(snakeRow);

  // Pastikan kabupaten_kota_create_ticket terisi valid (fallback logic jika kosong di raw data)
  const currentCity = String(
    row.kabupaten_kota_create_ticket || snakeRow.kabupaten_kota || snakeRow.city || "",
  ).trim();
  if (
    !currentCity ||
    currentCity === "-" ||
    currentCity === "'-" ||
    currentCity.toLowerCase() === "null"
  ) {
    try {
      const resolved = resolveCityFromTicketRow(rawRow);
      if (resolved && resolved.city) {
        row.kabupaten_kota_create_ticket = resolved.city;
      }
    } catch (e) {
      logger.warn("Failed resolving kabupaten_kota_create_ticket fallback", {
        error: e.message,
      });
    }
  }

  // Pastikan site_id1_l1_assign terisi valid (fallback logic Nomor 3 jika kosong/opaque)
  const currentSiteId = String(
    row.site_id1_l1_assign || snakeRow.site_id1 || snakeRow.site_id || "",
  ).trim();
  const isOpaque =
    /^\d{6,}$/i.test(currentSiteId) || /^[0-9A-F]{10,}$/i.test(currentSiteId);
  if (
    !currentSiteId ||
    currentSiteId === "-" ||
    currentSiteId === "'-" ||
    currentSiteId.toLowerCase() === "null" ||
    isOpaque
  ) {
    try {
      const resolved = resolveSiteFromTicketRow(rawRow);
      if (resolved && resolved.site_id) {
        row.site_id1_l1_assign = resolved.site_id;
      } else {
        row.site_id1_l1_assign = null;
      }
    } catch (e) {
      logger.warn("Failed resolving site_id1_l1_assign fallback", {
        error: e.message,
      });
      row.site_id1_l1_assign = null;
    }
  }

  // Pastikan description_fault_sumptomps_create_ticket_description_fault_sym terisi (fallback logic jika kosong di raw data)
  const currentFault = String(
    row.description_fault_sumptomps_create_ticket_description_fault_sym || "",
  ).trim();
  if (
    !currentFault ||
    currentFault === "-" ||
    currentFault === "'-" ||
    currentFault.toLowerCase() === "null"
  ) {
    let candidate = null;
    for (const [k, v] of Object.entries(snakeRow)) {
      if (/fault.*sym/i.test(k) || /sumptomp/i.test(k)) {
        const valStr = String(v || "").trim();
        if (
          valStr &&
          valStr !== "-" &&
          valStr !== "'-" &&
          valStr.toLowerCase() !== "null" &&
          valStr.toLowerCase() !== "undefined"
        ) {
          candidate = valStr;
          break;
        }
      }
    }
    if (!candidate) {
      const desc = String(
        snakeRow.description ||
          rawRow.description ||
          rawRow.Description ||
          "",
      ).trim();
      const paNsh = String(
        snakeRow.problem_analysis_nsh ||
          rawRow.problem_analysis_nsh ||
          rawRow["Problem Analysis NSH(L2 Assign)"] ||
          "",
      ).trim();
      const pa = String(
        snakeRow.problem_analysis ||
          rawRow.problem_analysis ||
          rawRow["Problem Analysis"] ||
          "",
      ).trim();

      if (
        desc &&
        desc !== "-" &&
        desc !== "'-" &&
        desc.toLowerCase() !== "null" &&
        desc.toLowerCase() !== "auto closed by system"
      ) {
        candidate = desc;
      } else if (
        paNsh &&
        paNsh !== "-" &&
        paNsh !== "'-" &&
        paNsh.toLowerCase() !== "null"
      ) {
        candidate = paNsh;
      } else if (
        pa &&
        pa !== "-" &&
        pa !== "'-" &&
        pa.toLowerCase() !== "null"
      ) {
        candidate = pa;
      } else if (desc && desc !== "-" && desc !== "'-" && desc.toLowerCase() !== "null") {
        candidate = desc;
      }
    }
    if (candidate) {
      row.description_fault_sumptomps_create_ticket_description_fault_sym = candidate;
    }
  }

  return row;
}

// melakukan bulk upsert data tiket 208 kolom ke tabel master PostgreSQL
export async function batchUpsertMasterTickets(rows, options = {}) {
  if (!rows || rows.length === 0) {
    return { total: 0, processed: 0, skipped: 0, inserted: 0, updated: 0 };
  }

  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || MASTER_TABLE;
  const fullTableName = `"${schema}".${table}`;

  logger.info("Starting batch upsert of master tickets", {
    rowCount: rows.length,
    table: fullTableName,
    filterAllowedL2Groups: Boolean(options.filterAllowedL2Groups),
  });

  const validColumns = await getValidMasterColumns(schema, table);
  const chunkSize = options.chunkSize || 100;
  let totalProcessed = 0;
  let totalSkipped = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    for (const rawRow of chunk) {
      const row = mapMasterTicketRow(rawRow, validColumns);
      const orderId = String(row.order_id || "").trim();
      if (!orderId || orderId === "-") continue;

      // Filter hanya 8 grup L2 yang diizinkan jika opsi aktif (abaikan NULL dan grup luar)
      if (options.filterAllowedL2Groups) {
        const assignGroup =
          row.assign_to_l2_l2_assign ||
          rawRow["Assign to L2(L2 Assign)"] ||
          rawRow["assignment_group"] ||
          rawRow["assign_to_l2"];
        if (!isAllowedInjectAssignGroup(assignGroup)) {
          totalSkipped += 1;
          continue;
        }
      }

      // Susun urutan kolom: date paling awal, disusul order_id, lalu kolom lainnya yang valid
      const remainingKeys = Object.keys(row).filter(
        (k) =>
          validColumns.has(k) &&
          k !== "date" &&
          k !== "order_id" &&
          k !== "created_at" &&
          k !== "updated_at",
      );
      const keys = ["date", "order_id", ...remainingKeys];
      const values = keys.map((k) => sanitizeCellValue(k, row[k]));

      // Tambahkan updated_at = NOW()
      const columnList = [...keys, "updated_at"].map((k) => `"${k}"`).join(", ");
      const placeholders = keys
        .map((_, idx) => `$${idx + 1}`)
        .concat(["NOW()"])
        .join(", ");

      const updateSet = keys
        .filter((k) => k !== "order_id")
        .map((k) => `"${k}" = COALESCE(EXCLUDED."${k}", ${fullTableName}."${k}")`)
        .concat(['"updated_at" = NOW()'])
        .join(", ");

      const sql = `
        INSERT INTO ${fullTableName} (${columnList})
        VALUES (${placeholders})
        ON CONFLICT ("order_id") DO UPDATE SET
          ${updateSet};
      `;

      await queryDatabase(sql, values);
      totalProcessed += 1;
    }
  }

  logger.info("Batch upsert completed", {
    totalRows: rows.length,
    processed: totalProcessed,
    skipped: totalSkipped,
  });

  return { total: rows.length, processed: totalProcessed, skipped: totalSkipped };
}

// mengonversi Excel serial date number (misal 45961.9428) ke Date object
export function parseExcelSerialDate(val) {
  if (val === null || val === undefined) return null;
  const num = typeof val === "number" ? val : Number(String(val).trim());
  if (Number.isFinite(num) && num > 1000 && num < 100000) {
    const utcDays = num - 25569;
    const ms = Math.round(utcDays * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// memformat tanggal ke format string ISO YYYY-MM-DD yang aman dan konsisten (zona waktu Asia/Jakarta)
export function formatIsoDateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: LOCAL_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  // Jika berupa Excel serial date (angka atau string float seperti 45961.9428)
  const serialDate = parseExcelSerialDate(value);
  if (serialDate) {
    return formatIsoDateOnly(serialDate);
  }

  const str = String(value).trim();
  const match = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const matchDmy = str.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})/);
  if (matchDmy) {
    const day = matchDmy[1].padStart(2, "0");
    const month = matchDmy[2].padStart(2, "0");
    const year = matchDmy[3];
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: LOCAL_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }
  return "";
}

// memformat tanggal dan waktu ke format SQL Standard Timestamp lokal WIB (YYYY-MM-DD HH:mm:ss.000)
export function formatWibTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: LOCAL_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
    }).formatToParts(value);
    const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const ms = m.fractionalSecond || "000";
    return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}.${ms}`;
  }

  // Cek apakah Excel serial date
  const serialDate = parseExcelSerialDate(value);
  if (serialDate) {
    return formatWibTimestamp(serialDate);
  }

  const str = String(value).trim();
  if (!str) return null;

  // Jika sudah format SQL 'YYYY-MM-DD HH:mm:ss'
  const matchSql = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?/);
  if (matchSql) {
    const ms = (matchSql[3] ? matchSql[3].slice(1, 4) : "000").padEnd(3, "0");
    return `${matchSql[1]} ${matchSql[2]}.${ms}`;
  }

  // Jika format 'DD/MM/YYYY HH:mm:ss' atau 'DD-MM-YYYY HH:mm:ss'
  const matchDmySql = str.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?/);
  if (matchDmySql) {
    const day = matchDmySql[1].padStart(2, "0");
    const month = matchDmySql[2].padStart(2, "0");
    const year = matchDmySql[3];
    const ms = (matchDmySql[5] ? matchDmySql[5].slice(1, 4) : "000").padEnd(3, "0");
    return `${year}-${month}-${day} ${matchDmySql[4]}.${ms}`;
  }

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return formatWibTimestamp(parsed);
  }

  return null;
}

// mengekstrak nilai tanggal YYYY-MM-DD dari row tiket (Prioritas 1: Order ID CC-YYYYMMDD-...)
export function extractTicketDate(row) {
  if (!row || typeof row !== "object") return null;

  // 1. Prioritas Utama (Ground Truth): Ambil dari Order ID (paling akurat, konsisten, dan tidak ambigu)
  const orderId = String(row.order_id || row["Order ID"] || "").trim();
  const m = orderId.match(/^CC-(\d{4})(\d{2})(\d{2})/i);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  // 2. Fallback jika format order_id bukan CC-YYYYMMDD: ambil dari kolom date
  if (row.date) {
    const d = formatIsoDateOnly(row.date);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  }

  // 3. Fallback: ambil dari create_time
  if (row.create_time) {
    const d = formatIsoDateOnly(row.create_time);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  }

  return null;
}

// memuat status riwayat pengiriman tiket dari tabel inap_sent_tickets_history untuk deduplikasi
export async function loadSentTicketMap(orderIds, options = {}) {
  const sentMap = new Map();
  if (!orderIds || orderIds.length === 0) {
    return sentMap;
  }

  const cleanOrderIds = orderIds
    .map((id) => cleanTableValue(id).toUpperCase())
    .filter((id) => Boolean(id) && id !== "-");

  if (cleanOrderIds.length === 0) {
    return sentMap;
  }

  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || SENT_TABLE;
  const fullTableName = `"${schema}".${table}`;

  const sql = `
    SELECT DISTINCT ON ("order_id")
      id,
      "order_id",
      dispatch_type,
      sent_at::text AS sent_at,
      sent_date::text AS sent_date,
      target_whatsapp_group_jid,
      source_request_jid,
      assigned_pic,
      target_destination,
      sla_status,
      business_status,
      reopen_count,
      is_repetitive,
      sent_to_site_visit,
      site_visit_sent_at::text AS site_visit_sent_at,
      site_visit_target_jid,
      escalated_from_previous
    FROM ${fullTableName}
    WHERE UPPER("order_id") = ANY($1::text[])
    ORDER BY "order_id", sent_at DESC;
  `;

  try {
    const result = await queryDatabase(sql, [cleanOrderIds]);
    for (const row of result.rows || []) {
      const normalizedId = String(row.order_id || "").trim().toUpperCase();
      sentMap.set(normalizedId, {
        order_id: row.order_id,
        assignment_type: row.target_destination === "SQA" ? "SQA" : "NOP",
        assignment_group: row.target_destination || "",
        cluster_area: row.target_destination || "",
        effective_target: row.target_destination || "",
        business_status: row.business_status || "",
        sla_status: row.sla_status || "",
        reopen_count: Number(row.reopen_count || 0),
        is_repetitive: Boolean(row.is_repetitive),
        sent_to_site_visit: Boolean(row.sent_to_site_visit),
        site_visit_sent_at: row.site_visit_sent_at ? new Date(row.site_visit_sent_at).toISOString() : "",
        site_visit_target_jid: row.site_visit_target_jid || "",
        escalated_from: row.escalated_from_previous || "",
        target_jid: row.target_whatsapp_group_jid || "",
        source_jid: row.source_request_jid || "",
        sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : "",
        sent_date: formatIsoDateOnly(row.sent_date),
      });
    }

    logger.info("Loaded sent ticket map from PostgreSQL", {
      requested: cleanOrderIds.length,
      found: sentMap.size,
    });
  } catch (error) {
    logger.error("Failed to load sent ticket map from PostgreSQL", {
      message: error.message,
    });
    throw error;
  }

  return sentMap;
}

// menentukan nilai kolom dispatch_type (NEW_TICKET, REOPEN, ESCALATION, SITE_VISIT, REMINDER)
export function resolveDispatchType(ticket = {}, metadata = {}) {
  const reopenCountValue = Number(
    cleanTableValue(
      ticket.reopen_number ?? ticket.reopen_count ?? ticket.reopenCount,
    ),
  );
  const reopenCount =
    Number.isFinite(reopenCountValue) && Number.isInteger(reopenCountValue) && reopenCountValue > 0
      ? reopenCountValue
      : 0;

  const effectiveTarget = resolveEffectiveTarget(ticket);
  const isSiteVisit =
    effectiveTarget === "SITE VISIT" &&
    (ticket.assignment_type === "SQA" || ticket.assignment_type === "SITE_VISIT" || !ticket.assignment_type);

  const isReminder = Boolean(
    metadata.isReminder ||
      metadata.dispatchType === "REMINDER" ||
      String(metadata.stage || "").toLowerCase().includes("reminder") ||
      ticket.is_reminder ||
      ticket.isReminder,
  );

  const isReopen = Boolean(
    ticket.use_reopen_message_format ||
      String(ticket.business_status || "").trim().toLowerCase() === "reopen" ||
      (reopenCount > 0 && !isSiteVisit),
  );

  const isEscalation = Boolean(
    ticket.escalated_from ||
      metadata.dispatchType === "ESCALATION" ||
      String(metadata.stage || "").toLowerCase().includes("escalation"),
  );

  return (
    metadata.dispatchType ||
    ticket.dispatch_type ||
    (isReminder
      ? "REMINDER"
      : isEscalation
      ? "ESCALATION"
      : isSiteVisit
      ? "SITE_VISIT"
      : isReopen
      ? "REOPEN"
      : "NEW_TICKET")
  );
}

// mencatat riwayat tiket yang berhasil dikirim ke tabel inap_sent_tickets_history
export async function recordSentTickets(tickets, metadata = {}, options = {}) {
  if (!tickets || tickets.length === 0) return;

  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || SENT_TABLE;
  const fullTableName = `"${schema}".${table}`;
  const now = new Date();
  const todayWib = getWibDateString(now);

  logger.info("Recording sent tickets to PostgreSQL history", {
    count: tickets.length,
    table: fullTableName,
  });

  for (const ticket of tickets) {
    const orderId = String(ticket.order_id || "").trim();
    if (!orderId || orderId === "-") continue;

    const reopenCountValue = Number(cleanTableValue(ticket.reopen_number));
    const reopenCount =
      Number.isFinite(reopenCountValue) && Number.isInteger(reopenCountValue)
        ? reopenCountValue
        : 0;

    const effectiveTarget = resolveEffectiveTarget(ticket);
    const isSiteVisit =
      effectiveTarget === "SITE VISIT" &&
      (ticket.assignment_type === "SQA" || ticket.assignment_type === "SITE_VISIT" || !ticket.assignment_type);
    const dispatchType = resolveDispatchType(ticket, metadata);

    const masterTable = options.masterTable || MASTER_TABLE;
    const fullMasterTableName = `"${schema}".${masterTable}`;

    // Pastikan order_id sudah ada di master table untuk memenuhi foreign key constraint
    try {
      await queryDatabase(
        `INSERT INTO ${fullMasterTableName} ("order_id", created_at, updated_at)
         VALUES ($1, NOW(), NOW())
         ON CONFLICT ("order_id") DO NOTHING;`,
        [orderId],
      );
    } catch (stubErr) {
      logger.warn("Failed to ensure master ticket stub in PostgreSQL", {
        orderId,
        error: stubErr.message,
      });
    }

    const sql = `
      INSERT INTO ${fullTableName} (
        "order_id",
        dispatch_type,
        sent_at,
        sent_date,
        target_whatsapp_group_jid,
        source_request_jid,
        assigned_pic,
        target_destination,
        sla_status,
        business_status,
        reopen_count,
        is_repetitive,
        sent_to_site_visit,
        site_visit_sent_at,
        site_visit_target_jid,
        escalated_from_previous
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);
    `;

    const values = [
      orderId,
      dispatchType,
      now,
      todayWib,
      metadata.targetJid || "",
      metadata.sourceJid || "",
      ticket.pic || "",
      effectiveTarget,
      ticket.sla_status || "",
      ticket.business_status || "",
      reopenCount,
      Boolean(ticket.is_repetitive),
      Boolean(isSiteVisit || ticket.sent_to_site_visit),
      isSiteVisit ? now : null,
      isSiteVisit ? metadata.targetJid || "" : null,
      ticket.escalated_from || null,
    ];

    try {
      await queryDatabase(sql, values);
    } catch (error) {
      logger.error("Failed to record sent ticket history in PostgreSQL", {
        orderId,
        error: error.message,
      });
      throw error;
    }
  }

  logger.info("Successfully recorded sent tickets to PostgreSQL", {
    count: tickets.length,
  });
}

// membersihkan data riwayat pengiriman tiket di inap_sent_tickets_history yang lebih lama dari 14 hari (2 minggu)
export async function cleanOldSentHistory(retentionDays = 14, options = {}) {
  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || SENT_TABLE;
  const fullTableName = `"${schema}".${table}`;
  const days = Number(retentionDays) > 0 ? Number(retentionDays) : 14;

  const sql = `
    DELETE FROM ${fullTableName}
    WHERE sent_date < (CURRENT_DATE - ($1 || ' days')::interval);
  `;

  try {
    const result = await queryDatabase(sql, [days]);
    const deletedCount = result?.rowCount || 0;
    if (deletedCount > 0) {
      logger.info("Purged old sent ticket history", {
        table: fullTableName,
        retentionDays: days,
        deletedCount,
      });
    }
    return { deletedCount };
  } catch (error) {
    logger.warn("Failed to purge old sent ticket history", {
      table: fullTableName,
      error: error.message,
    });
    return { deletedCount: 0, error: error.message };
  }
}

export { getWibDateString };
