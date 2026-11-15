import assert from "node:assert/strict";
import test from "node:test";

import {
  createCityResolver,
  createSiteResolver,
  extractSiteCoverFromRow,
} from "../src/services/siteSearchService.js";
import { processTicketExcel } from "../src/services/ticketImportService.js";
import writeXlsxFile from "write-excel-file/node";

test("extracts site cover from cch_suggestion_2 and cch_suggestion_3", () => {
  const row = {
    "CCH Suggestion(L1 Assign_cch_suggestion)": "other: Fault_cell_or_site: 51010BACAE20",
    "cch_suggestion_2(L1 Assign)": "other: Fault_cell_or_site: E_JHO067MT1_TEUREUBEH-PTI_MT01",
    "Problem Analysis NSH": "Safe",
  };

  const extracted = extractSiteCoverFromRow(row);
  assert.equal(extracted, "JHO067");
});

test("resolves site correctly when site_id1 contains opaque hex CGI and Problem Analysis NSH has site cover", () => {
  const resolveSite = createSiteResolver({
    rows: [
      {
        site_id: "IRY030",
        site_name: "BANTAYAN",
        kabupaten: "KABUPATEN ACEH TIMUR",
        vendor: "TELKOMSEL",
        departement_ns: "NOP ACEH",
      },
    ],
  });

  const row = {
    "Order ID": "CC-20260827-00000752",
    "site_id1(L1 Assign)": "51010BC3C821",
    "Problem Analysis NSH": "Lokasi : aceh timur\n\n#Site cover  : IRY030\nIRY030ML1_BANTAYANML01",
  };

  const result = resolveSite(row);
  assert.equal(result.ok, true);
  assert.equal(result.site_id, "IRY030");
  assert.equal(result.site_name, "BANTAYAN");
  assert.equal(result.city, "KABUPATEN ACEH TIMUR");
});

test("processTicketImport selects readable Problem Analysis NSH or CCH2 when CCH1 only has opaque hex CGI", async () => {
  const schema = [
    { column: "Order ID", type: String, value: (d) => d.orderId },
    { column: "Ticket Id", type: String, value: (d) => d.ticketId },
    { column: "Create Time", type: String, value: (d) => d.createTime },
    { column: "Business Status", type: String, value: (d) => d.status },
    { column: "Assignment Group", type: String, value: (d) => d.group },
    { column: "Assign to L2(L2 Assign)", type: String, value: (d) => d.assignL2 },
    { column: "Kabupaten/Kota(Create Ticket)", type: String, value: (d) => d.city },
    { column: "site_id1(L1 Assign)", type: String, value: (d) => d.siteId1 },
    { column: "Problem Analysis NSH", type: String, value: (d) => d.nsh },
    { column: "CCH Suggestion(L1 Assign_cch_suggestion)", type: String, value: (d) => d.cch1 },
    { column: "cch_suggestion_2(L1 Assign)", type: String, value: (d) => d.cch2 },
    { column: "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)", type: String, value: (d) => d.desc },
    { column: "Customer MSISDN(Create Ticket_customer_msisdn)", type: String, value: (d) => d.msisdn },
  ];

  const data = [
    {
      orderId: "CC-20260827-00000752",
      ticketId: "1-SLLK2DG",
      createTime: "2026-08-27 23:44:50",
      status: "InProgress",
      group: "Service Quality Assurance Sumbagut",
      assignL2: "group:Service Quality Assurance Sumbagut",
      city: "ACEH TIMUR",
      siteId1: "51010BC3C821",
      nsh: "#Site cover  : IRY030\nIRY030ML1_BANTAYANML01\nACTION PLAN : - Optim",
      cch1: "cause: Radio_Cell_Congestion, other: Fault_cell_or_site: 51010BC3C821",
      cch2: "cause: Not_Dominant_Coverage, other: Fault_cell_or_site: 51010BC3C821",
      desc: "Detail: internet lambat",
      msisdn: "6282217016646",
    },
  ];

  const buffer = await writeXlsxFile(data, { schema, buffer: true });
  const result = await processTicketExcel(buffer);

  assert.equal(result.ok, true);
  assert.equal(result.valid_tickets.length, 1);
  const ticket = result.valid_tickets[0];

  // Analysis text must prefer Problem Analysis NSH because it has readable site cover IRY030
  assert.match(ticket.analysis_text, /#Site cover\s*:\s*IRY030/);
});
