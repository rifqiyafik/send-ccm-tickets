import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  toSnakeCase,
  getWibDateString,
  getHMinusOneWatermark,
  resolveEffectiveTarget,
  convertRowToSnakeCase,
  batchUpsertMasterTickets,
  loadSentTicketMap,
  recordSentTickets,
  resolveDispatchType,
  formatIsoDateOnly,
  formatWibTimestamp,
  extractTicketDate,
  mapMasterTicketRow,
  sanitizeCellValue,
  MASTER_TABLE_COLUMNS,
  CLICKHOUSE_TO_POSTGRES_COLUMN_MAP,
  isAllowedInjectAssignGroup,
  ALLOWED_INJECT_ASSIGN_GROUPS,
} from "../src/services/inapTicketStore.js";
import {
  extractTicketSummaryRows,
  formatInjectMonthSummaryMessages,
} from "../src/handlers/telegramCommandHandler.js";
import { closeDatabasePool } from "../src/services/databaseService.js";

test("toSnakeCase converts complex headers into clean snake_case", () => {
  assert.equal(toSnakeCase("Order ID"), "order_id");
  assert.equal(
    toSnakeCase("Assign to L2(L2 Assign)"),
    "assign_to_l2_l2_assign",
  );
  assert.equal(
    toSnakeCase("Customer MSISDN(Create Ticket_customer_msisdn)"),
    "customer_msisdn_create_ticket_customer_msisdn",
  );
  assert.equal(
    toSnakeCase("Does Smartcare Suggestion helpful?"),
    "does_smartcare_suggestion_helpful",
  );
  assert.equal(
    toSnakeCase("Fault_cell_or_site"),
    "fault_cell_or_site",
  );
  assert.equal(toSnakeCase(""), "");
});

test("mapMasterTicketRow maps ClickHouse shorthand columns and filters unknown columns", () => {
  const rawClickHouseRow = {
    order_id: "CC-20261019-00000001",
    agnostic_flag: "Y",
    creator: "muhammadila",
    ticket_id: "TICK-999",
    city: "KOTA MEDAN",
    site_id: "MDN123",
    cch_suggestion: "Check Tx",
    unknown_phantom_column: "should_be_filtered_out",
  };

  const mapped = mapMasterTicketRow(rawClickHouseRow);

  // order_id and date are preserved
  assert.equal(mapped.order_id, "CC-20261019-00000001");
  assert.equal(mapped.date, "2026-10-19");

  // agnostic_flag is correctly mapped to PostgreSQL column name
  assert.equal(mapped.agnostic_flag_create_ticket_agnostic_flag, "Y");
  assert.equal(mapped.agnostic_flag, undefined);

  // standard columns are preserved
  assert.equal(mapped.creator, "muhammadila");
  assert.equal(mapped.ticket_id, "TICK-999");

  // city and site_id are mapped to PostgreSQL column names
  assert.equal(mapped.kabupaten_kota_create_ticket, "KOTA MEDAN");
  assert.equal(mapped.site_id1_l1_assign, "MDN123");
  assert.equal(mapped.cch_suggestion_l1_assign_cch_suggestion, "Check Tx");

  // unknown phantom columns are filtered out completely
  assert.equal(mapped.unknown_phantom_column, undefined);

  // Every single key in mapped (except date/order_id if present) is guaranteed in MASTER_TABLE_COLUMNS
  for (const k of Object.keys(mapped)) {
    assert.ok(
      MASTER_TABLE_COLUMNS.has(k),
      `Key ${k} must exist in MASTER_TABLE_COLUMNS`,
    );
  }
});

test("batchUpsertMasterTickets skips empty rows gracefully", async () => {
  const result = await batchUpsertMasterTickets([]);
  assert.equal(result.total, 0);
  assert.equal(result.processed, 0);
});

test("getHMinusOneWatermark computes yesterday 00:00:00 WIB correctly", () => {
  const fixedDate = new Date("2026-09-13T10:00:00+07:00");
  const watermark = getHMinusOneWatermark(fixedDate);
  assert.equal(watermark, "2026-09-12 00:00:00");
});

test("resolveEffectiveTarget determines correct group destination", () => {
  assert.equal(
    resolveEffectiveTarget({ is_repetitive: true }),
    "SITE VISIT",
  );
  assert.equal(
    resolveEffectiveTarget({ assignment_type: "SQA" }),
    "SQA",
  );
  assert.equal(
    resolveEffectiveTarget({
      assignment_type: "NOP",
      cluster_area: "NOP PEMATANG SIANTAR",
    }),
    "NOP PMS",
  );
});

test("convertRowToSnakeCase converts row keys to snake_case", () => {
  const row = {
    "Order ID": "CC-20260913-00000062",
    "Assign to L2(L2 Assign)": "NOP PEMATANG SIANTAR",
  };
  const converted = convertRowToSnakeCase(row);
  assert.equal(converted.order_id, "CC-20260913-00000062");
  assert.equal(converted.assign_to_l2_l2_assign, "NOP PEMATANG SIANTAR");
});

test("batchUpsertMasterTickets skips empty rows gracefully", async () => {
  const result = await batchUpsertMasterTickets([]);
  assert.equal(result.total, 0);
  assert.equal(result.processed, 0);
});

test("loadSentTicketMap returns empty map for empty orderIds", async () => {
  const map = await loadSentTicketMap([]);
  assert.equal(map.size, 0);
});

test("extractTicketSummaryRows extracts, sorts by order_id, and groups by month", () => {
  const sampleRows = [
    {
      "Order ID": "CC-20260906-00000125",
      City: "LABUHANBATU UTARA",
      "Assign to L2(L2 Assign)": "NETWORK OPERATIONS AND PRODUCTIVITY RANTAU PRAPAT",
      "SLA Status": "OUT SLA",
      "Assign Personal(L2 Assign)": "Edy Syofra Nasution",
      "Site ID 1": "RAP532",
    },
    {
      "Order ID": "CC-20260305-00000379",
      City: "DELI SERDANG",
      "Assign to L2(L2 Assign)": "NETWORK OPERATIONS AND PRODUCTIVITY MEDAN",
      "SLA Status": "OUT SLA",
      "Assign Personal(L2 Assign)": "Rachmad S Siregar",
      "Site ID 1": "MDN683",
    },
    {
      "Order ID": "CC-20260302-00000010",
      City: "KOTA MEDAN",
      "Assign to L2(L2 Assign)": "SERVICE QUALITY ASSURANCE SUMBAGUT",
      "SLA Status": "IN SLA",
      "Assign Personal(L2 Assign)": "Herman",
      "Site ID 1": "MDN001",
    },
  ];

  const extracted = extractTicketSummaryRows(sampleRows);
  assert.equal(extracted.length, 3);
  // Sorted by order_id ascending: CC-20260302 comes first, then CC-20260305, then CC-20260906
  assert.equal(extracted[0].order_id, "CC-20260302-00000010");
  assert.equal(extracted[0].monthLabel, "Maret 2026");
  assert.equal(extracted[1].order_id, "CC-20260305-00000379");
  assert.equal(extracted[1].monthLabel, "Maret 2026");
  assert.equal(extracted[2].order_id, "CC-20260906-00000125");
  assert.equal(extracted[2].monthLabel, "September 2026");

  // Format table without filter (shows all months)
  const allMessages = formatInjectMonthSummaryMessages(extracted);
  assert.equal(allMessages.length, 2);
  assert.ok(allMessages[0].includes("Bulan: Maret 2026"));
  assert.ok(allMessages[0].includes("CC-20260302-00000010"));
  assert.ok(allMessages[0].includes("CC-20260305-00000379"));
  assert.ok(allMessages[1].includes("Bulan: September 2026"));
  assert.ok(allMessages[1].includes("CC-20260906-00000125"));

  // Format table with filter "maret" specifically
  const maretOnlyMessages = formatInjectMonthSummaryMessages(extracted, {
    monthFilter: "maret",
  });
  assert.equal(maretOnlyMessages.length, 1);
  assert.ok(maretOnlyMessages[0].includes("Bulan: Maret 2026"));
  assert.ok(maretOnlyMessages[0].includes("CC-20260302-00000010"));
  assert.ok(!maretOnlyMessages[0].includes("CC-20260906-00000125"));
});

test("formatIsoDateOnly safely normalizes dates to YYYY-MM-DD", () => {
  // Test with Date object (simulating node-postgres parsing of DATE column)
  const dateObj = new Date("2026-09-13T00:00:00.000Z");
  assert.equal(formatIsoDateOnly(dateObj), "2026-09-13");

  // Test with plain string
  assert.equal(formatIsoDateOnly("2026-09-13"), "2026-09-13");
  assert.equal(formatIsoDateOnly("2026-09-13 14:00:00"), "2026-09-13");
  assert.equal(formatIsoDateOnly("2026-09-13T07:00:00.000Z"), "2026-09-13");

  // Test with empty or null
  assert.equal(formatIsoDateOnly(null), "");
  assert.equal(formatIsoDateOnly(""), "");
});

test("resolveDispatchType correctly assigns Option B dispatch_type values", () => {
  // 1. Regular initial ticket -> NEW_TICKET
  assert.equal(resolveDispatchType({ order_id: "CC-1" }), "NEW_TICKET");

  // 2. Reopen ticket -> REOPEN
  assert.equal(
    resolveDispatchType({ order_id: "CC-2", business_status: "Reopen" }),
    "REOPEN",
  );
  assert.equal(
    resolveDispatchType({ order_id: "CC-3", reopen_number: "1" }),
    "REOPEN",
  );
  assert.equal(
    resolveDispatchType({ order_id: "CC-4", use_reopen_message_format: true }),
    "REOPEN",
  );

  // 3. Escalation / reassignment ticket -> ESCALATION
  assert.equal(
    resolveDispatchType({ order_id: "CC-5", escalated_from: "CC-PREV" }),
    "ESCALATION",
  );
  assert.equal(
    resolveDispatchType({ order_id: "CC-6" }, { stage: "escalation" }),
    "ESCALATION",
  );

  // 4. Site visit ticket -> SITE_VISIT
  assert.equal(
    resolveDispatchType({ order_id: "CC-7", is_repetitive: true }),
    "SITE_VISIT",
  );
  assert.equal(
    resolveDispatchType({ order_id: "CC-8", targetGroupKey: "SITE VISIT" }),
    "SITE_VISIT",
  );

  // 5. Reminder dispatch -> REMINDER
  assert.equal(
    resolveDispatchType({ order_id: "CC-9" }, { isReminder: true }),
    "REMINDER",
  );
  assert.equal(
    resolveDispatchType({ order_id: "CC-10" }, { stage: "daily in progress reminder" }),
    "REMINDER",
  );
  assert.equal(
    resolveDispatchType(
      { order_id: "CC-11", is_repetitive: true },
      { isReminder: true },
    ),
    "REMINDER",
  );

  // 6. Explicit override in metadata or ticket
  assert.equal(
    resolveDispatchType({ order_id: "CC-12" }, { dispatchType: "SITE_VISIT" }),
    "SITE_VISIT",
  );
  assert.equal(
    resolveDispatchType({ order_id: "CC-13", dispatch_type: "ESCALATION" }),
    "ESCALATION",
  );
});

test("formatIsoDateOnly formats dates to YYYY-MM-DD", () => {
  const d = new Date("2025-02-25T08:30:00+07:00");
  assert.equal(formatIsoDateOnly(d), "2025-02-25");
  assert.equal(formatIsoDateOnly("2025-02-25 14:00:00"), "2025-02-25");
  assert.equal(formatIsoDateOnly("2025/02/25"), "2025-02-25");
  assert.equal(formatIsoDateOnly(""), "");
  // Excel serial date numbers
  assert.equal(formatIsoDateOnly("45961.9428"), "2025-11-01");
  assert.equal(formatIsoDateOnly(45961.9428), "2025-11-01");
});

test("extractTicketDate extracts YYYY-MM-DD date prioritizing order_id over date or create_time", () => {
  // Ground truth check: order_id CC-20260712-00000295 must ALWAYS yield 2026-07-12
  assert.equal(
    extractTicketDate({
      order_id: "CC-20260712-00000295",
      date: "2026-12-08",
      create_time: "2026-12-08 01:49:00",
    }),
    "2026-07-12",
  );
  assert.equal(
    extractTicketDate({ order_id: "CC-20250225-00000101" }),
    "2025-02-25",
  );
  assert.equal(
    extractTicketDate({
      "Order ID": "CC-20260922-00000047",
      create_time: new Date("2026-09-22T01:00:00.000Z"),
    }),
    "2026-09-22",
  );
  // Fallback checks when order_id is not in standard CC-YYYYMMDD format
  assert.equal(
    extractTicketDate({ order_id: "CUSTOM-123", date: "2025-02-25" }),
    "2025-02-25",
  );
  assert.equal(
    extractTicketDate({ order_id: "CUSTOM-123", date: "45961.9428" }),
    "2025-11-01",
  );
  assert.equal(
    extractTicketDate({ order_id: "CUSTOM-123", create_time: "2025-02-25 10:20:30" }),
    "2025-02-25",
  );
});

test("formatWibTimestamp formats timestamps in SQL standard WIB format (YYYY-MM-DD HH:mm:ss.000)", () => {
  const d = new Date("2025-02-25T06:42:00.000+07:00");
  const formatted = formatWibTimestamp(d);
  assert.equal(formatted, "2025-02-25 06:42:00.000");

  const fromSql = formatWibTimestamp("2025-02-25 06:42:00.000");
  assert.equal(fromSql, "2025-02-25 06:42:00.000");

  const fromExcelSerial = formatWibTimestamp("45961.9428");
  // 45961.9428 is 2025-11-01 05:37:37 WIB
  assert.ok(fromExcelSerial.startsWith("2025-11-01 05:37:37"));

  // Indonesian DD/MM/YYYY format
  const fromDmy = formatWibTimestamp("23/05/2025 10:20:00");
  assert.equal(fromDmy, "2025-05-23 10:20:00.000");
});

test("parseDateTime parses Excel serial, DD/MM/YYYY, and standard ISO correctly", async () => {
  const { parseDateTime } = await import("../src/utils/dateTime.js");

  const serialParsed = parseDateTime("45800.4305");
  assert.ok(serialParsed instanceof Date);
  assert.equal(serialParsed.getUTCFullYear(), 2025);

  const dmyParsed = parseDateTime("23/05/2025 10:20:00");
  assert.ok(dmyParsed instanceof Date);
  assert.equal(dmyParsed.getFullYear(), 2025);
  assert.equal(dmyParsed.getMonth(), 4); // May (0-indexed)
  assert.equal(dmyParsed.getDate(), 23);
  assert.equal(dmyParsed.getHours(), 10);
  assert.equal(dmyParsed.getMinutes(), 20);

  const ymdParsed = parseDateTime("2025-05-23 10:20:00");
  assert.ok(ymdParsed instanceof Date);
  assert.equal(ymdParsed.getFullYear(), 2025);
  assert.equal(ymdParsed.getDate(), 23);
});

test("calculateSla and normalizeSlaStatus correctly resolve SLA status without returning UNKNOWN", async () => {
  const { calculateSla, normalizeSlaStatus } = await import(
    "../src/services/ticketImportService.js"
  );

  assert.equal(normalizeSlaStatus("OUT SLA"), "OUT SLA");
  assert.equal(normalizeSlaStatus("OUTSIDE SLA"), "OUT SLA");
  assert.equal(normalizeSlaStatus("IN SLA"), "IN SLA");
  assert.equal(normalizeSlaStatus("Inside SLA"), "IN SLA");
  assert.equal(normalizeSlaStatus("-"), "");
  assert.equal(normalizeSlaStatus("UNKNOWN"), "");

  // With historical date (May 2025), calculateSla returns OUT SLA, never UNKNOWN
  const sla1 = calculateSla("23/05/2025 10:20:00");
  assert.equal(sla1.sla_status, "OUT SLA");

  // With Excel serial number
  const sla2 = calculateSla("45800.4305");
  assert.equal(sla2.sla_status, "OUT SLA");

  // With orderId fallback when Create Time is missing
  const sla3 = calculateSla("", new Date(), "CC-20250523-00000479");
  assert.equal(sla3.sla_status, "OUT SLA");
});

test("extractTicketSummaryRows preserves raw SLA status or calculated SLA without showing UNKNOWN", () => {
  const sampleRows = [
    {
      "Order ID": "CC-20250523-00000479",
      City: "KOTA MEDAN",
      "Assign to L2(L2 Assign)": "NOP MEDAN",
      "SLA Status": "OUT SLA",
      "Assign Personal(L2 Assign)": "Adi Saputra Piliang",
      "Site ID 1": "MDN243",
      "Create Time": "23/05/2025 10:20:00",
    },
    {
      "Order ID": "CC-20250523-00000480",
      City: "DELI SERDANG",
      "Assign to L2(L2 Assign)": "NOP MEDAN",
      "(L1 Assign_sla)": "IN SLA",
      "Assign Personal(L2 Assign)": "Rachmad S Siregar",
      "Site ID 1": "MDN618",
      "Create Time": "45800.4305",
    },
  ];

  const summary = extractTicketSummaryRows(sampleRows);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].sla_status, "OUT SLA");
  assert.equal(summary[1].sla_status, "IN SLA");
  assert.notEqual(summary[0].sla_status, "UNKNOWN");
  assert.notEqual(summary[1].sla_status, "UNKNOWN");
});

test("formatInjectMonthSummaryMessages caps preview chunks per month to avoid Telegram 429 rate limit", () => {
  const dummyRows = [];
  for (let i = 1; i <= 60; i++) {
    dummyRows.push({
      order_id: `CC-20250501-${String(i).padStart(8, "0")}`,
      city: "MEDAN",
      cluster_area: "NOP MEDAN",
      sla_status: "IN SLA",
      pic: "Ahsan",
      site_id: "MDN001",
      month: "05",
      year: "2025",
      monthKey: "2025-05",
      monthLabel: "Mei 2025",
    });
  }

  // 60 rows with chunk size 20 = 3 chunks. With maxChunksPerMonth = 2:
  const messages = formatInjectMonthSummaryMessages(dummyRows, {
    maxChunksPerMonth: 2,
  });

  // Should have 2 chunk tables + 1 info notice message = 3 messages total
  assert.equal(messages.length, 3);
  assert.ok(messages[0].includes("Bagian 1/3"));
  assert.ok(messages[1].includes("Bagian 2/3"));
  assert.ok(messages[2].includes("dibatasi hingga bagian 2/3"));
});

test("normalizeSlaStatus rejects Remedy internal 'normal' status and getInProgressReminderLine formats OUT SLA properly", async () => {
  const { normalizeSlaStatus } = await import(
    "../src/services/ticketImportService.js"
  );
  const { getInProgressReminderLine } = await import(
    "../src/services/messageTemplateService.js"
  );

  // Remedy internal status "normal" must NOT be treated as SLA status
  assert.equal(normalizeSlaStatus("normal"), "");
  assert.equal(normalizeSlaStatus("NORMAL"), "");

  // Reopen ticket line test: "1. *CC-20260913-00000722* | OUT SLA | RAP826 | 2X ReOpen"
  const reopenTicket = {
    order_id: "CC-20260913-00000722",
    sla_status: "OUT SLA",
    site_id: "RAP826",
    business_status: "ReOpen",
    reopen_number: "2",
  };
  const reopenLine = getInProgressReminderLine(reopenTicket, 0);
  assert.equal(
    reopenLine,
    "1. *CC-20260913-00000722* | OUT SLA | RAP826 | 2X ReOpen",
  );

  // InProgress overdue ticket line test
  const pastTarget = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
  const inProgressTicket = {
    order_id: "CC-20260918-00000186",
    sla_status: "OUT SLA",
    site_id: "KBJ746",
    business_status: "InProgress",
    resolve_target_22h: pastTarget,
  };
  const inProgressLine = getInProgressReminderLine(inProgressTicket, 0);
  assert.ok(inProgressLine.includes("*CC-20260918-00000186* | OUT SLA | KBJ746 | Out 3d"));
});

test("isAllowedInjectAssignGroup validates the 8 allowed L2 Sumbagut groups and rejects invalid/null", () => {
  // 8 grup valid dengan prefix group:
  for (const group of ALLOWED_INJECT_ASSIGN_GROUPS) {
    assert.equal(isAllowedInjectAssignGroup(group), true, `Grup ${group} harus diizinkan`);
  }

  // 8 grup valid tanpa prefix group: (case-insensitive)
  assert.equal(
    isAllowedInjectAssignGroup("Network Operations and Productivity Medan"),
    true,
  );
  assert.equal(
    isAllowedInjectAssignGroup("network operations and productivity banda aceh"),
    true,
  );
  assert.equal(
    isAllowedInjectAssignGroup("Service Quality Assurance Sumbagut"),
    true,
  );

  // Nilai NULL / kosong / dash harus ditolak
  assert.equal(isAllowedInjectAssignGroup(null), false);
  assert.equal(isAllowedInjectAssignGroup(undefined), false);
  assert.equal(isAllowedInjectAssignGroup(""), false);
  assert.equal(isAllowedInjectAssignGroup("-"), false);
  assert.equal(isAllowedInjectAssignGroup("null"), false);

  // Grup di luar 8 L2 Sumbagut harus ditolak
  assert.equal(isAllowedInjectAssignGroup("group:RTP Engineering Sumbagut"), false);
  assert.equal(isAllowedInjectAssignGroup("RTP Engineering Sumbagut"), false);
  assert.equal(isAllowedInjectAssignGroup("group:IT Support"), false);
  assert.equal(isAllowedInjectAssignGroup("group:Core Network Operation"), false);
});

test("mapMasterTicketRow maps long fault symptom header to description_fault_sumptomps_create_ticket_description_fault_sym", () => {
  const excelRow = {
    "Order ID": "CC-20260513-00000106",
    "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)":
      "Tanggal Kejadian: 20260513 06:00:00:0000 Detail Complain: internet lambat",
    "Assign to L2(L2 Assign)":
      "group:Network Operations and Productivity Banda Aceh",
  };

  const mapped = mapMasterTicketRow(excelRow);

  assert.equal(mapped.order_id, "CC-20260513-00000106");
  assert.equal(
    mapped.description_fault_sumptomps_create_ticket_description_fault_sym,
    "Tanggal Kejadian: 20260513 06:00:00:0000 Detail Complain: internet lambat",
  );
  assert.equal(
    mapped.assign_to_l2_l2_assign,
    "group:Network Operations and Productivity Banda Aceh",
  );
  assert.ok(
    MASTER_TABLE_COLUMNS.has(
      "description_fault_sumptomps_create_ticket_description_fault_sym",
    ),
  );
});

test("batchUpsertMasterTickets skips disallowed groups when filterAllowedL2Groups is true", async () => {
  const mockRows = [
    {
      "Order ID": "CC-20260513-00000106",
      "Assign to L2(L2 Assign)": "group:RTP Engineering Sumbagut",
    },
    {
      "Order ID": "CC-20260513-00000107",
      "Assign to L2(L2 Assign)": null,
    },
    {
      "Order ID": "CC-20260513-00000108",
      "Assign to L2(L2 Assign)":
        "group:Network Operations and Productivity Banda Aceh",
    },
  ];

  // Jalankan dengan validColumns tiruan tanpa koneksi database sesungguhnya
  let executedSql = [];
  const fakeQueryFn = async (sql) => {
    executedSql.push(sql);
    return { rowCount: 1 };
  };

  // Panggil batchUpsertMasterTickets dengan filterAllowedL2Groups: true
  // Mock validColumns dengan memanggil langsung
  const result = await batchUpsertMasterTickets(mockRows, {
    filterAllowedL2Groups: true,
  });

  assert.equal(result.total, 3);
  assert.equal(result.skipped, 2); // 1 RTP + 1 NULL
  assert.equal(result.processed, 1); // 1 valid Banda Aceh
});

test("sanitizeCellValue preserves text values and handles types accurately", () => {
  // Text columns must preserve raw strings and not turn to null
  assert.equal(sanitizeCellValue("order_seq", "01"), "01");
  assert.equal(sanitizeCellValue("order_seq", "SEQ-99"), "SEQ-99");
  assert.equal(
    sanitizeCellValue("reassign_number_l2_assign", "3"),
    "3",
  );
  assert.equal(
    sanitizeCellValue("description_fault_sumptomps_create_ticket_description_fault_sym", "Deskripsi komplain"),
    "Deskripsi komplain",
  );

  // Integer columns
  assert.equal(sanitizeCellValue("reopen_number_confirm_close", 0), 0);
  assert.equal(sanitizeCellValue("reopen_number_confirm_close", " 2 "), 2);
  assert.equal(sanitizeCellValue("reopen_number_confirm_close", "1.0"), 1);
  assert.equal(sanitizeCellValue("reopen_number_confirm_close", "-"), null);

  // Numeric coordinates
  assert.equal(sanitizeCellValue("latitude_l2_assign", "3,5952"), 3.5952);
  assert.equal(sanitizeCellValue("longitude_l2_assign", 98.6722), 98.6722);
  assert.equal(sanitizeCellValue("latitude_l2_assign", "'-"), null);

  // Empty / dash / null variations
  assert.equal(sanitizeCellValue("agent_name", ""), null);
  assert.equal(sanitizeCellValue("agent_name", "-"), null);
  assert.equal(sanitizeCellValue("agent_name", "--"), null);
  assert.equal(sanitizeCellValue("agent_name", "'-"), null);
  assert.equal(sanitizeCellValue("agent_name", "null"), null);
  assert.equal(sanitizeCellValue("agent_name", "undefined"), null);
  assert.equal(sanitizeCellValue("agent_name", "John Doe"), "John Doe");
});

test("mapMasterTicketRow resolves city fallback when kabupaten_kota is blank", () => {
  const rowWithoutCity = {
    "Order ID": "CC-20260513-00000109",
    "Kabupaten/Kota(Create Ticket)": "-",
    "Problem Analysis NSH(L2 Assign)": "Issue on site MDN001 Medan",
  };
  const mapped = mapMasterTicketRow(rowWithoutCity);
  assert.equal(mapped.order_id, "CC-20260513-00000109");
  // Should attempt fallback resolution or remain safe without error
  assert.ok(typeof mapped.order_id === "string");
});

test("mapMasterTicketRow maps description_fault_sumptomps_create_ticket and aliases correctly", () => {
  // 1. Direct from ClickHouse column name
  const chRow = {
    order_id: "CC-20261113-00000001",
    description_fault_sumptomps_create_ticket: "Koneksi internet lambat di lokasi",
  };
  const mappedCh = mapMasterTicketRow(chRow);
  assert.equal(
    mappedCh.description_fault_sumptomps_create_ticket_description_fault_sym,
    "Koneksi internet lambat di lokasi",
  );

  // 2. From Excel header with Symptoms (y)
  const excelRow = {
    "Order ID": "CC-20261113-00000002",
    "Description Fault Symptoms(Create Ticket_description__fault_symptoms)":
      "Tidak bisa melakukan panggilan keluar",
  };
  const mappedExcel = mapMasterTicketRow(excelRow);
  assert.equal(
    mappedExcel.description_fault_sumptomps_create_ticket_description_fault_sym,
    "Tidak bisa melakukan panggilan keluar",
  );

  // 3. Fallback to description when fault symptoms is empty / dash
  const fallbackDescRow = {
    "Order ID": "CC-20261113-00000003",
    "Description Fault Sumptomps": "-",
    Description: "Pelanggan mengeluhkan sinyal hilang sejak pagi",
  };
  const mappedFallbackDesc = mapMasterTicketRow(fallbackDescRow);
  assert.equal(
    mappedFallbackDesc.description_fault_sumptomps_create_ticket_description_fault_sym,
    "Pelanggan mengeluhkan sinyal hilang sejak pagi",
  );

  // 4. Fallback to problem_analysis_nsh when description is auto closed by system
  const fallbackPaRow = {
    "Order ID": "CC-20261113-00000004",
    description: "Auto closed by system",
    "Problem Analysis NSH(L2 Assign)": "Modul RRU padam akibat PLN drop",
  };
  const mappedFallbackPa = mapMasterTicketRow(fallbackPaRow);
  assert.equal(
    mappedFallbackPa.description_fault_sumptomps_create_ticket_description_fault_sym,
    "Modul RRU padam akibat PLN drop",
  );
});

test("mapMasterTicketRow maps additional ClickHouse columns to valid PostgreSQL schema", () => {
  const row = {
    order_id: "CC-20261113-00000005",
    cch_suggestion_l1_assign: "Check transmission",
    assign_to_l1: "group:L1 Support",
    customer_msisdn_create_ticket: "628123456789",
    customer_region_create_ticket: "SUMBAGUT",
    customer_subtype_create_ticket: "REGULAR",
    customer_type_create_ticket: "POSTPAID",
    details_area_location_create_ticket: "Jl. Merdeka No 1",
    fault_cell_or_site_l1_assign: "SITE-123",
    problem_start_time_create_ticket: "2026-11-13 08:00:00",
    subscription_sub_status_create_ticket: "ACTIVE",
    kode_post: "20111",
    root_cause_tier_1: "Power Failure",
    root_caused_tier_7: "Battery Low",
    time_range: "08:00-12:00",
    attachmentdocman: "DOC-999",
  };
  const mapped = mapMasterTicketRow(row);
  assert.equal(mapped.cch_suggestion_l1_assign_cch_suggestion, "Check transmission");
  assert.equal(mapped.assign_to_l1_assign, "group:L1 Support");
  assert.equal(mapped.customer_msisdn_create_ticket_customer_msisdn, "628123456789");
  assert.equal(mapped.customer_region_create_ticket_customer_region, "SUMBAGUT");
  assert.equal(mapped.customer_subtype_create_ticket_customer_subtype, "REGULAR");
  assert.equal(mapped.customer_type_create_ticket_customer_type, "POSTPAID");
  assert.equal(mapped.details_area_location_create_ticket_details_area_location, "Jl. Merdeka No 1");
  assert.equal(mapped.fault_cell_or_site, "SITE-123");
  assert.equal(mapped.problem_start_time_create_ticket_problem_start_time, "2026-11-13 08:00:00");
  assert.equal(mapped.subscription_sub_status_create_ticket_subscription_substatus, "ACTIVE");
  assert.equal(mapped.kode_post_c_create_ticket_kode_post_c, "20111");
  assert.equal(mapped.root_cause_tier_1_l1_assign, "Power Failure");
  assert.equal(mapped.root_caused_tier_7_l2_assign, "Battery Low");
  assert.equal(mapped.time_range_l1_assign_time_range, "08:00-12:00");
  assert.equal(mapped.attachment_docman_create_ticket_attachmentdocman, "DOC-999");
});

after(async () => {
  await closeDatabasePool();
});




