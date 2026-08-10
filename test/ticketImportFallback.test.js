import assert from "node:assert/strict";
import test from "node:test";
import writeXlsxFile from "write-excel-file/node";

import { processTicketExcel } from "../src/services/ticketImportService.js";

const HEADERS = [
  "Order ID",
  "Ticket Id",
  "Create Time",
  "Business Status",
  "Assign to L2(L2 Assign)",
  "Kabupaten/Kota(Create Ticket)",
  "site_id1(L1 Assign)",
  "Problem Analysis NSH",
  "CCH Suggestion(L1 Assign_cch_suggestion)",
  "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)",
  "Customer MSISDN(Create Ticket_customer_msisdn)",
  "Problem Start Time",
  "Customer Interaction Date(Create Ticket)",
  "Desa/Kelurahan(Create Ticket)",
  "kecamatan(Create Ticket)",
  "Description",
  "Problem Analysis",
  "Assign Personal(L2 Assign)",
  "Resolution Categorization Tier 1",
  "Resolution Categorization Tier 3",
  "Resolution Categorization Tier 2(L1 Assign)",
  "Root Caused Tier 1(L2 Assign)",
  "Root Caused Tier 2(L2 Assign)",
  "Root Caused Tier 3(L2 Assign)",
  "Root Caused Tier 8(L2 Assign)",
  "Site ID(L2 Assign)",
];

function row(overrides = {}) {
  return {
    "Order ID": "CC-20260723-00000001",
    "Ticket Id": "TICKET-1",
    "Create Time": "2026-07-25 03:21:18",
    "Business Status": "In Progress",
    "Assign to L2(L2 Assign)": "SERVICE QUALITY ASSURANCE SUMBAGUT",
    "Kabupaten/Kota(Create Ticket)": "ACEH BESAR",
    "site_id1(L1 Assign)": "JHO293",
    "Problem Analysis NSH":
      "Performance KPI beberapa hari terakhir terlihat normal.",
    "CCH Suggestion(L1 Assign_cch_suggestion)":
      "cause: The root cause is not found, suggestion: null, other: null",
    "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)": "",
    "Customer MSISDN(Create Ticket_customer_msisdn)": "6281229724194",
    "Problem Start Time": "2026-07-23 03:21:18",
    "Customer Interaction Date(Create Ticket)": "2026-07-23 03:21:18",
    "Desa/Kelurahan(Create Ticket)": "SUKAMULIAMAKMUR",
    "kecamatan(Create Ticket)": "Darul Makmur",
    Description:
      "K31-Internet - Lambat/lemot/nge-lag, Signal tidak stabil/lemah",
    "Problem Analysis": "Remark reopen",
    ...overrides,
  };
}

async function createWorkbookBuffer(rows) {
  return writeXlsxFile(
    [
      HEADERS.map((header) => ({ type: String, value: header })),
      ...rows.map((item) =>
        HEADERS.map((header) => ({
          type: String,
          value: String(item[header] ?? ""),
        })),
      ),
    ],
    { buffer: true },
  );
}

test("uses fallback notes and Problem Analysis NSH when message fields are empty or invalid", async () => {
  const buffer = await createWorkbookBuffer([row()]);
  const result = await processTicketExcel(buffer);

  assert.equal(result.ok, true);
  assert.equal(result.valid_tickets.length, 1);

  const ticket = result.valid_tickets[0];
  assert.equal(
    ticket.notes,
    [
      "Problem Start Time : 2026-07-23 03:21:18",
      "Customer Interaction Date : 2026-07-23 03:21:18",
      "Customer MSISDN : 6281229724194",
      "Alamat : Kelurahan SUKAMULIAMAKMUR, Kecamatan Darul Makmur, Kabupaten/Kota ACEH BESAR",
      "Complaint Detail : K31-Internet - Lambat/lemot/nge-lag, Signal tidak stabil/lemah",
    ].join("\n"),
  );
  assert.equal(
    ticket.analysis_text,
    "Performance KPI beberapa hari terakhir terlihat normal.",
  );
  assert.deepEqual(
    ticket.fallback_resolutions.map((resolution) => resolution.field),
    ["notes", "analysis_text"],
  );
});

test("keeps analysis empty when CCH suggestion is invalid and Problem Analysis NSH is empty", async () => {
  const buffer = await createWorkbookBuffer([
    row({
      "Order ID": "CC-20260723-00000002",
      "Problem Analysis NSH": "",
    }),
  ]);
  const result = await processTicketExcel(buffer);

  assert.equal(result.ok, true);
  assert.equal(result.valid_tickets.length, 1);
  assert.equal(result.valid_tickets[0].analysis_text, "");
  assert.deepEqual(
    result.valid_tickets[0].fallback_resolutions.map(
      (resolution) => resolution.field,
    ),
    ["notes"],
  );
});

test("sets use_reopen_message_format to false when ReOpen ticket does NOT have all 9 L2 columns filled", async () => {
  const buffer = await createWorkbookBuffer([
    row({
      "Order ID": "CC-20260723-00000003",
      "Business Status": "ReOpen",
      "Assign Personal(L2 Assign)": "Herman",
      // Only 1 column filled out of 9
    }),
  ]);
  const result = await processTicketExcel(buffer);

  assert.equal(result.ok, true);
  assert.equal(result.valid_tickets.length, 1);
  assert.equal(result.valid_tickets[0].use_reopen_message_format, false);
});

test("sets use_reopen_message_format to true when ReOpen ticket has ALL 9 L2 columns filled", async () => {
  const buffer = await createWorkbookBuffer([
    row({
      "Order ID": "CC-20260723-00000004",
      "Business Status": "ReOpen",
      "Assign Personal(L2 Assign)": "Herman",
      "Resolution Categorization Tier 1": "NETWORK",
      "Resolution Categorization Tier 3": "CELL DOWN",
      "Resolution Categorization Tier 2(L1 Assign)": "RADIO",
      "Root Caused Tier 1(L2 Assign)": "HARDWARE",
      "Root Caused Tier 2(L2 Assign)": "BOARD",
      "Root Caused Tier 3(L2 Assign)": "UBBP",
      "Root Caused Tier 8(L2 Assign)": "FAULTY",
      "Site ID(L2 Assign)": "JHO293",
    }),
  ]);
  const result = await processTicketExcel(buffer);

  assert.equal(result.ok, true);
  assert.equal(result.valid_tickets.length, 1);
  assert.equal(result.valid_tickets[0].use_reopen_message_format, true);
});
