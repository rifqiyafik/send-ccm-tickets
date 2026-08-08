import assert from "node:assert/strict";
import test from "node:test";

import { extractCityFromDescription } from "../src/utils/descriptionCityExtractor.js";
import { getTargetGroupKey } from "../src/config/whatsappRouting.js";
import { searchPicByCityAndAssignment } from "../src/services/picSearchService.js";
import { formatProcessingReport, processTicketRows } from "../src/services/ticketImportService.js";

test("extracts Sumbagut city from Lokasi Pelanggan description line", () => {
  const text = `Tanggal Kejadian: 20260722 06:00:00:0000
Lokasi Pelanggan (alamat) : DESA SAMPAIMAH, KEC. MANYAK PAYED, ACEH TAMIANG, ACEH
Hasil analisa CCA :`;

  const ccmRows = [
    { city: "ACEH TAMIANG", departement_ns: " NOP BINJAI" },
    { city: "DELI SERDANG", departement_ns: " NOP MEDAN" },
  ];

  const city = extractCityFromDescription(text, ccmRows);
  assert.equal(city, "ACEH TAMIANG");
});

test("routes NOP Binjai ticket with Deli Serdang city & Aceh Tamiang description to NOP BINJAI and Rizlul Khairi", () => {
  const ticket = {
    assignment_type: "NOP",
    assignment_group: "NETWORK OPERATIONS AND PRODUCTIVITY BINJAI",
    cluster_area: "NOP MEDAN",
  };

  const targetGroupKey = getTargetGroupKey(ticket);
  assert.equal(targetGroupKey, "NOP BINJAI");

  const descriptionText =
    "Lokasi Pelanggan (alamat) : DESA SAMPAIMAH, KEC. MANYAK PAYED, ACEH TAMIANG, ACEH";
  const picResult = searchPicByCityAndAssignment({
    city: "DELI SERDANG",
    assignmentGroup: "NETWORK OPERATIONS AND PRODUCTIVITY BINJAI",
    descriptionText,
  });

  assert.equal(picResult.ok, true);
  assert.equal(picResult.assignment_type, "NOP");
  assert.equal(picResult.city, "ACEH TAMIANG");
  assert.equal(picResult.pic_nop, "Rizlul Khairi");
  assert.match(picResult.anomaly_info, /Mismatch Kota Utama \(DELI SERDANG\)/);
  assert.match(picResult.anomaly_info, /ACEH TAMIANG/);
});

test("routes NOP Medan ticket with out-of-region Bekasi site BKS851 to NOP MEDAN with fallback default PIC Medan", () => {
  const ticket = {
    assignment_type: "NOP",
    assignment_group: "NETWORK OPERATIONS AND PRODUCTIVITY MEDAN",
    cluster_area: "",
  };

  const targetGroupKey = getTargetGroupKey(ticket);
  assert.equal(targetGroupKey, "NOP MEDAN");

  const descriptionText =
    "Lokasi Pelanggan (alamat) : JALAN AHMAD YANI, BEKASI, JAWA BARAT";
  const picResult = searchPicByCityAndAssignment({
    city: "BEKASI",
    assignmentGroup: "NETWORK OPERATIONS AND PRODUCTIVITY MEDAN",
    descriptionText,
  });

  assert.equal(picResult.ok, true);
  assert.equal(picResult.assignment_type, "NOP");
  assert.ok(picResult.pic_nop);
  assert.match(picResult.anomaly_info, /Fallback PIC Default/);
});

test("skips out-of-region SQA ticket and records anomaly for Telegram report", () => {
  const rows = [
    {
      "Order ID": "CC-20260803-00000509",
      "Ticket Id": "1-S7ZZ13P",
      "Create Time": "2026-08-03 20:27:01",
      "Business Status": "In Progress",
      "Assign to L2(L2 Assign)": "Service Quality Assurance Sumbagut",
      "Kabupaten/Kota(Create Ticket)": "BEKASI",
      "site_id1(L1 Assign)": "BKS851",
      "Problem Analysis NSH": "#Site Cover : BKS851",
      "CCH Suggestion(L1 Assign_cch_suggestion)": "-",
      "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)":
        "Lokasi Pelanggan (alamat) : BEKASI, JAWA BARAT",
      "Customer MSISDN(Create Ticket_customer_msisdn)": "628138215118",
    },
  ];

  const result = processTicketRows(rows);
  assert.equal(result.valid_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.skipped_tickets[0].reason, "CITY_NOT_FOUND");

  const report = formatProcessingReport(result);
  assert.match(report, /⚠️ Tiket Anomali Dilewati \(Tidak Dikirim ke WA\)/);
  assert.match(report, /CC-20260803-00000509/);
});
