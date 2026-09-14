import test from "node:test";
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
  formatIsoDateOnly,
} from "../src/services/inapTicketStore.js";
import {
  extractTicketSummaryRows,
  formatInjectMonthSummaryMessages,
} from "../src/handlers/telegramCommandHandler.js";

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
