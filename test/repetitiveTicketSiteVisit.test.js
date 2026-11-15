import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  resolveTsSiteVisit,
  formatTsMentionHeader,
} from "../src/services/siteVisitService.js";
import {
  formatRepetitiveEscalationPayload,
  formatEscalationMessagePayload,
  extractCustomerDetailsSummary,
  extractRepetitiveNote,
} from "../src/services/messageTemplateService.js";
import {
  processTicketExcel,
  formatProcessingReport,
} from "../src/services/ticketImportService.js";
import { getTargetGroupKey } from "../src/config/whatsappRouting.js";
import writeXlsxFile from "write-excel-file/node";

test("resolves TS Site Visit per area correctly with dual tags for Binjai, Sidempuan, Siantar", () => {
  // Medan
  const tsMedan = resolveTsSiteVisit({ city: "KOTA MEDAN" });
  assert.equal(tsMedan.length, 1);
  assert.equal(tsMedan[0].name, "Willy Panjaitan");
  assert.equal(tsMedan[0].phone, "6285207769555");
  assert.equal(formatTsMentionHeader(tsMedan), "bang @6285207769555");

  // Aceh
  const tsAceh = resolveTsSiteVisit({ city: "ACEH BESAR" });
  assert.equal(tsAceh.length, 1);
  assert.equal(tsAceh[0].name, "Riski");
  assert.equal(tsAceh[0].phone, "62811688993");
  assert.equal(formatTsMentionHeader(tsAceh), "bang @62811688993");

  // Binjai (2 TS)
  const tsBinjai = resolveTsSiteVisit({ city: "LANGKAT" });
  assert.equal(tsBinjai.length, 2);
  assert.equal(tsBinjai[0].name, "Pewenri");
  assert.equal(tsBinjai[1].name, "Dedi");
  assert.equal(formatTsMentionHeader(tsBinjai), "bang @6285260045597 & bang @6281214456231");

  // Sidempuan (2 TS)
  const tsPsp = resolveTsSiteVisit({ city: "KOTA PADANG SIDEMPUAN" });
  assert.equal(tsPsp.length, 2);
  assert.equal(tsPsp[0].name, "Januar");
  assert.equal(tsPsp[1].name, "Okis");
  assert.equal(formatTsMentionHeader(tsPsp), "bang @628116103388 & bang @6281397033246");

  // Siantar (2 TS)
  const tsPms = resolveTsSiteVisit({ city: "SIMALUNGUN" });
  assert.equal(tsPms.length, 2);
  assert.equal(tsPms[0].name, "Rudi");
  assert.equal(tsPms[1].name, "Dedek");
  assert.equal(formatTsMentionHeader(tsPms), "bang @6282272329397 & bang @6281321111779");
});

test("getTargetGroupKey returns SITE VISIT for repetitive ticket", () => {
  const ticket = {
    assignment_type: "SQA",
    assignment_group: "Service Quality Assurance Sumbagut",
    is_repetitive: true,
  };
  assert.equal(getTargetGroupKey(ticket), "SITE VISIT");
});

test("formatRepetitiveEscalationPayload produces expected template and mentions", () => {
  const ticket = {
    order_id: "CC-20260821-00000575",
    assignment_type: "SQA",
    city: "KOTA MEDAN",
    pic_sqa: "Fernando Pasaribu",
    is_repetitive: true,
    resolve_target_22h_text: "Sabtu / 22 Agu 2026, 06:44:09 PM",
    customer_summary_text: [
      "Nama Customer : SELAMET PURNOMO",
      "MSISDN-A Yang Menghubungi : 6282272524309",
      "MSISDN-B Yang Bermasalah : 6282272524309",
      "Tanggal/Jam Kejadian : 16/08/2026 17:00-20:00",
      "Lokasi Pelanggan (alamat) : Sei Putih Barat, Medan Petisah, Kota Medan",
      "Koordinat customer : ",
      "SIM Capability : USIM",
      "Customer Tier Pelanggan : Gold",
      "Case Owner : E-Care Bandung",
      "Detail Complain : kendala jaringan lambat",
      "Capture CCA : https://imgur.com/undefined",
    ].join("\n"),
    ccm_analysis: "Performance KPI beberapa hari terakhir disaat kejadian terlihat Normal dan tidak ada yang Anomali, avail, UL interference, Capacity dan Transport masih aman. Perkiraan site cover pelanggan lebih dominan di cover  MDN442 Sek-3. \nPotensial Problem : Closed",
    repetitive_note: "-",
  };

  const payload = formatRepetitiveEscalationPayload(ticket);
  assert.ok(payload.text.includes("Mohon dibantu bang @6285207769555"));
  assert.ok(payload.text.includes("CC-20260821-00000575"));
  assert.ok(payload.text.includes("CC bang @628126099949 & bang @628118035472")); // Fernando SQA & Bagus SQA
  assert.ok(payload.text.includes("Ticket Complain Repetitif"));
  assert.ok(payload.text.includes("Nama Customer : SELAMET PURNOMO"));
  assert.ok(payload.text.includes("CCM Analysis : Performance KPI beberapa hari terakhir disaat kejadian terlihat Normal dan tidak ada yang Anomali, avail, UL interference, Capacity dan Transport masih aman. Perkiraan site cover pelanggan lebih dominan di cover  MDN442 Sek-3."));
  assert.ok(!payload.text.includes("Potensial Problem"));
  assert.ok(!payload.text.includes("Note :"));
  assert.ok(payload.text.includes("SLA DUE DATE 24H : *Sabtu / 22 Agu 2026, 06:44:09 PM*"));
  assert.ok(payload.text.includes("Mohon dibantu ya bang🙏🏻🙏🏻"));

  // Mention JIDs include TS, SQA, and Bagus
  assert.ok(payload.mentions.includes("6285207769555@s.whatsapp.net"));
  assert.ok(payload.mentions.includes("628126099949@s.whatsapp.net"));
  assert.ok(payload.mentions.includes("628118035472@s.whatsapp.net"));
});

test("processTicketExcel handles ReOpen = 3 and ReOpen > 3 correctly", async () => {
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
    { column: "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)", type: String, value: (d) => d.desc },
    { column: "Customer MSISDN(Create Ticket_customer_msisdn)", type: String, value: (d) => d.msisdn },
    { column: "Reopen Number(Confirm Close)", type: String, value: (d) => d.reopenNumber },
    { column: "Resolution(L2 Assign)", type: String, value: (d) => d.resolution },
  ];

  const data = [
    // Case 1: ReOpen = 3 -> Should generate 2 valid ticket entries (1 for SQA, 1 for Site Visit)
    {
      orderId: "CC-20260821-00000575",
      ticketId: "1-SLLK2DG",
      createTime: "2026-08-21 23:44:50",
      status: "ReOpen",
      group: "Service Quality Assurance Sumbagut",
      assignL2: "group:Service Quality Assurance Sumbagut",
      city: "KOTA MEDAN",
      siteId1: "MDN629",
      nsh: "#Site cover  : MDN629",
      cch1: "cause: Radio_Cell_Congestion",
      desc: "Nama Customer : SELAMET PURNOMO\nMSISDN-A Yang Menghubungi : 6282272524309\nNote: Mohon pengawalan",
      msisdn: "6282272524309",
      reopenNumber: "3",
      resolution: "Performance KPI Normal",
    },
    // Case 2: ReOpen = 4 (> 3) -> Should generate 1 valid ticket entry ONLY for Site Visit (not SQA)
    {
      orderId: "CC-20260821-00000576",
      ticketId: "1-SLLK2DH",
      createTime: "2026-08-21 23:44:50",
      status: "ReOpen",
      group: "Service Quality Assurance Sumbagut",
      assignL2: "group:Service Quality Assurance Sumbagut",
      city: "LANGKAT",
      siteId1: "BJI182",
      nsh: "#Site cover  : BJI182",
      cch1: "cause: Radio_Cell_Congestion",
      desc: "Nama Customer : Budi\nMSISDN-A Yang Menghubungi : 628123456789\nNote: Urgent",
      msisdn: "628123456789",
      reopenNumber: "4",
      resolution: "Capacity issue solved",
    },
  ];

  const buffer = await writeXlsxFile(data, { schema, buffer: true });
  // CC-20260821-00000576 has already been sent to SQA in this test scenario
  const result = await processTicketExcel(buffer, {
    hasBeenSentToSqa: (id) => id === "CC-20260821-00000576",
  });

  assert.equal(result.ok, true);
  // Total valid tickets = 2 for Case 1 (SQA + Site Visit) + 1 for Case 2 (Site Visit only) = 3
  assert.equal(result.valid_tickets.length, 3);

  const t1Sqa = result.valid_tickets.find((t) => t.order_id === "CC-20260821-00000575" && !t.is_repetitive);
  assert.ok(t1Sqa, "Case 1 SQA ticket exists");
  assert.equal(t1Sqa.assignment_type, "SQA");

  const t1SiteVisit = result.valid_tickets.find((t) => t.order_id === "CC-20260821-00000575" && t.is_repetitive);
  assert.ok(t1SiteVisit, "Case 1 Site Visit ticket exists");
  assert.equal(t1SiteVisit.targetGroupKey, "SITE VISIT");
  assert.equal(t1SiteVisit.ts_site_visit[0].name, "Willy Panjaitan");

  const t2SiteVisit = result.valid_tickets.find((t) => t.order_id === "CC-20260821-00000576");
  assert.ok(t2SiteVisit, "Case 2 Site Visit ticket exists");
  assert.equal(t2SiteVisit.is_repetitive, true);
  assert.equal(t2SiteVisit.targetGroupKey, "SITE VISIT");
  assert.equal(t2SiteVisit.ts_site_visit.length, 2); // Binjai Pewenri & Dedi

  const report = formatProcessingReport(result);
  assert.ok(report.includes("Tiket Repetitif (>3 ReOpen / Site Visit)"));
  assert.ok(report.includes("CC-20260821-00000576"));
  assert.ok(report.includes("Willy Panjaitan"));
  assert.ok(report.includes("Pewenri, Dedi"));
});

test("sendReminderCommandResult sends repetitive reminder to SITE VISIT group", async () => {
  const customStorePath = path.join("tmp", `site-visit-remind-${Date.now()}.json`);
  process.env.SENT_TICKET_STORE_PATH = customStorePath;

  const sentMessages = [];
  const mockSock = {
    sendMessage: async (jid, payload) => {
      sentMessages.push({ jid, payload });
      return { key: { id: "mock-id" } };
    },
  };

  const validTickets = [
    {
      order_id: "CC-BRAND-NEW-001",
      assignment_type: "SQA",
      city: "LANGKAT",
      pic_sqa: "Herman",
      is_repetitive: true,
      targetGroupKey: "SITE VISIT",
      resolve_target_22h_text: "Sabtu / 22 Agu 2026",
      notes: "Nama Customer: Budi",
      ccm_analysis: "PRB Capacity",
      repetitive_note: "Mohon tindak lanjut",
    },
  ];

  const { sendReminderCommandResult } = await import(
    "../src/handlers/whatsappMessageHandler.js"
  );

  await sendReminderCommandResult(mockSock, "telegram:123", validTickets, {
    manualMode: true,
  });

  const siteVisitMsg = sentMessages.find(
    (m) =>
      m.payload.text &&
      m.payload.text.includes("Ticket Complain Repetitif"),
  );
  assert.ok(siteVisitMsg, "Site Visit message was sent");
  assert.equal(siteVisitMsg.jid, "telegram:123", "Site Visit draft sent to sourceJid for manual sending");
  assert.ok(siteVisitMsg.payload.text.includes("CC-BRAND-NEW-001"));

  fs.rmSync(customStorePath, { force: true });
  delete process.env.SENT_TICKET_STORE_PATH;
});

test("resolveTargetJid in manualMode returns synthetic key when WA JID is empty", async () => {
  const { resolveTargetJid } = await import(
    "../src/config/whatsappRouting.js"
  );
  const result = resolveTargetJid(
    {
      order_id: "CC-20260821-00000576",
      is_repetitive: true,
      targetGroupKey: "SITE VISIT",
    },
    { manualMode: true },
  );
  assert.ok(result === "manual:SITE VISIT" || result.includes("g.us"));
});

test("formatSiteVisitCombinedReminderPayload produces multi-area grouped reminder with SQA and Bg Bagus CC", async () => {
  const { formatSiteVisitCombinedReminderPayload } = await import(
    "../src/services/messageTemplateService.js"
  );

  const tickets = [
    {
      order_id: "CC-20260830-00000640",
      city: "KOTA MEDAN",
      site_id: "MDN442",
      sla_status: "IN SLA",
      resolve_target_22h_text: "Senin / 31 Agu 2026, 04:10 PM",
      pic_sqa: "Fernando Pasaribu",
      raw_description: "Lokasi Pelanggan (alamat) : Sei Putih Barat, Kota Medan\nDetail Complain : Jaringan lambat & sinyal drop",
    },
    {
      order_id: "CC-20260830-00000642",
      city: "SIMALUNGUN",
      site_id: "STR005",
      sla_status: "OUT SLA",
      resolve_target_22h_text: "Minggu / 30 Agu 2026, 10:00 AM",
      pic_sqa: "Ahsan",
      raw_description: "Lokasi Pelanggan (alamat) : Simalungun\nDetail Complain : Sinyal hilang timbul",
    },
  ];

  const payload = formatSiteVisitCombinedReminderPayload(tickets);
  assert.ok(payload.text.includes("REMINDER TIKET REPETITIF / SITE VISIT"));
  assert.ok(payload.text.includes("Summary:"));
  assert.ok(payload.text.includes("TS MEDAN"));
  assert.ok(payload.text.includes("TS SIANTAR"));
  assert.ok(payload.text.includes("CC-20260830-00000640"));
  assert.ok(payload.text.includes("CC-20260830-00000642"));
  assert.ok(payload.text.includes("CC Pengawalan & Koordinasi:"));
  assert.ok(payload.text.includes("Mohon kesediaan dan kerjasamanya"));

  // Mentions should contain TS and SQA tags
  assert.ok(payload.mentions.includes("6285207769555@s.whatsapp.net")); // Willy
  assert.ok(payload.mentions.includes("6282272329397@s.whatsapp.net")); // Rudi
  assert.ok(payload.mentions.includes("628118035472@s.whatsapp.net")); // Bagus
});

test("sendReminderCommandResult sends combined reminder in manualMode for previously sent tickets", async () => {
  const sentMessages = [];
  const mockSock = {
    sendMessage: async (jid, payload) => {
      sentMessages.push({ jid, payload });
      return { key: { id: "mock-id" } };
    },
  };

  const { markTicketAsSent } = await import("../src/services/sentTicketService.js");
  const ticket = {
    order_id: "CC-20260821-00000999",
    assignment_type: "SQA",
    city: "KOTA MEDAN",
    pic_sqa: "Fernando Pasaribu",
    is_repetitive: true,
    targetGroupKey: "SITE VISIT",
    resolve_target_22h_text: "Sabtu / 22 Agu 2026",
    notes: "Nama Customer: Budi",
    ccm_analysis: "PRB Capacity",
  };

  // Pre-mark ticket as sent
  await markTicketAsSent(ticket, { sourceJid: "telegram:123", targetJid: "manual:SITE VISIT" });

  const { sendReminderCommandResult } = await import(
    "../src/handlers/whatsappMessageHandler.js"
  );

  await sendReminderCommandResult(mockSock, "telegram:123", [ticket], {
    manualMode: true,
  });

  const combinedMsg = sentMessages.find(
    (m) => m.payload.text && m.payload.text.includes("REMINDER TIKET REPETITIF / SITE VISIT"),
  );
  assert.ok(combinedMsg, "Site Visit combined reminder message was sent");
  assert.ok(combinedMsg.payload.text.includes("CC-20260821-00000999"));
  assert.ok(combinedMsg.payload.text.includes("TS MEDAN"));
});

test("cleanAddressToCity trims address up to city and removes province, country, and postal code", async () => {
  const { cleanAddressToCity } = await import(
    "../src/services/messageTemplateService.js"
  );

  assert.equal(
    cleanAddressToCity(
      "JL MENJANGAN NO 6A/14A KEL PANDAU HULU I KEC MEDAN KOTA, MEDAN, SUMATERA UTARA, Indonesia 28772",
    ),
    "JL MENJANGAN NO 6A/14A KEL PANDAU HULU I KEC MEDAN KOTA, MEDAN",
  );

  assert.equal(
    cleanAddressToCity(
      "Jl. Panglima Polem No. 12, Banda Aceh, Aceh, Indonesia 23122",
    ),
    "Jl. Panglima Polem No. 12, Banda Aceh",
  );

  assert.equal(
    cleanAddressToCity(
      "Dusun II Desa Telagah Kec. Sei Bingai, Kab. Langkat, SUMUT",
    ),
    "Dusun II Desa Telagah Kec. Sei Bingai, Kab. Langkat",
  );
});

test("does not treat Site Visit as cross-assignment escalation", async () => {
  const customStorePath = path.join("tmp", `site-visit-no-esc-${Date.now()}.json`);
  process.env.SENT_TICKET_STORE_PATH = customStorePath;

  const { markTicketAsSent, createSentTicketPlan } = await import(
    "../src/services/sentTicketService.js"
  );

  const ticket = {
    order_id: "CC-20260830-00000650",
    assignment_type: "SQA",
    assignment_group: "SERVICE QUALITY ASSURANCE SUMBAGUT",
    cluster_area: "NOP BINJAI",
    business_status: "ReOpen",
    sla_status: "IN SLA",
    reopen_number: 3,
    is_repetitive: true,
  };

  // Mark ticket as sent to SITE VISIT
  await markTicketAsSent({ ...ticket, targetGroupKey: "SITE VISIT" }, { targetJid: "manual:SITE VISIT" });

  // Now evaluate primary SQA ticket on .update
  const plan = await createSentTicketPlan([ticket], new Date());
  assert.equal(plan.escalated_tickets.length, 0, "Should not be flagged as escalated ticket");
  assert.ok(!ticket.escalated_from, "ticket.escalated_from should be empty");

  fs.rmSync(customStorePath, { force: true });
  delete process.env.SENT_TICKET_STORE_PATH;
});

test("extractCustomerDetailsSummary cleanly extracts single-line CRM text without runaway repetition or Customer(Create Ticket) dependency", () => {
  const singleLine =
    "Nama Customer : FANDI MSISDN-A Yang Menghubungi :6281370344934 MSISDN-B Yang Bermasalah : 6282277236060 Tanggal/Jam Kejadian :16/08/2026 10:00 - 11:00 Lokasi Pelanggan (alamat) : jalan madura lingkungan 3 kel kebun lada kec binjai utara , kota binjai, patokan dkt paud muda cerima Koordinat customer : - Segmentasi Kartu : LOOP Capability : USIM Customer Tier Pelanggan : Silver Case Owner : Call Center Bandung Detail Complain : Ybs menghubungi kembali terkait kendala yang sama,Tdk bsa browsing inet , sinyal data e, HP xiamie di jar tidak ada , full bar , kendala SEMUA APP Additional Information : kendala semua lokasi lokasi baik didalam-diluar ruangan , kendala dialami no tsel lain, ybs blm coba speedtest. Capture bukti pelanggan : Capture CCA : https://prnt.sc/nS8hq0TJk8n2 Hasil analisa CCA :No matched data is found Possible Root Cause UE_Handset_Problem_4G Remarks Bapak atau Ibu Yth, setelah pengecekan di sistem kami, kami menemukan issue pada deviceatausim card yang digunakan. Jika restart device tidak menyelesaikan masalah maka disarankan untuk mengganti nomor sim ke Grapari Suggestion TIDAK PERLU CREATE TIKET KE TIM NETWORK. Adanya indikasi sim card atau handphone pelanggan bermasalah, anjurkan pelanggan untuk restart handphone. Jika masalah tetap ada, anjurkan pelanggan untuk mengganti sim card pada Grapari terdekat. Solusi: ybs sdah coba sesuai pansol namun masih kendala , ybs info sudah lakukan ganti kartu ke grpari binjai bulan 7 lalu, nmn kendala masih konsisten di alami. Co bantu tiket , mhon bantuannya trisms, Dear rekan NO,";

  const row = {
    "Customer(Create Ticket)": "WRONG_NAME_FROM_CRM_COLUMN",
  };

  const summary = extractCustomerDetailsSummary(singleLine, row);

  // Verifikasi Nama Customer HANYA diambil dari teks (FANDI), bukan dari kolom Customer(Create Ticket)
  assert.ok(summary.includes("Nama Customer : FANDI"));
  assert.ok(!summary.includes("WRONG_NAME_FROM_CRM_COLUMN"));

  // Verifikasi MSISDN terpisah bersih
  assert.ok(summary.includes("MSISDN-A Yang Menghubungi : 6281370344934"));
  assert.ok(summary.includes("MSISDN-B Yang Bermasalah : 6282277236060"));

  // Verifikasi Tanggal & Lokasi berhenti tepat sebelum token berikutnya
  assert.ok(summary.includes("Tanggal/Jam Kejadian : 16/08/2026 10:00 - 11:00"));
  assert.ok(
    summary.includes(
      "Lokasi Pelanggan (alamat) : jalan madura lingkungan 3 kel kebun lada kec binjai utara , kota binjai, patokan dkt paud muda cerima",
    ),
  );

  // Verifikasi Detail Complain tidak menelan Remarks/Suggestion
  assert.ok(
    summary.includes(
      "Detail Complain : Ybs menghubungi kembali terkait kendala yang sama,Tdk bsa browsing inet , sinyal data e, HP xiamie di jar tidak ada , full bar , kendala SEMUA APP",
    ),
  );

  // Verifikasi Capture CCA hanya mengambil URL murni
  assert.ok(summary.includes("Capture CCA : https://prnt.sc/nS8hq0TJk8n2"));
  assert.ok(!summary.includes("Hasil analisa CCA :No matched data is found"));

  // Panjang total summary tidak boleh membengkak (normal ~700 karakter, bukan 11.000 karakter)
  assert.ok(
    summary.length < 1000,
    `Summary length ${summary.length} should be under 1000 characters`,
  );
});

test("extractCustomerDetailsSummary handles Bahtiar Serdang Bedagai complaint format", () => {
  const bahtiarText = `Tanggal Kejadian: 20260912 17:00:00:0000
Tanggal Kejadian Berakhir: 20260912 20:00:00:0000

[TikTok dm] [Silver] [NO]
Nama Customer: BAHTIAR
MSISDN-A Yang Bermasalah : 081265538866
MSISDN-B Yang Bermasalah : 081265969100
Tanggal/Jam Kejadian: 17:00 - 20:00 12/09/2026
Lokasi Pelanggan (alamat) : Kelurahan suka sari, kec pejagalan, kab serdang bedagai
Koordinat customer :
Segmentasi Kartu :
SIM Capability :
Customer Tier Pelanggan : Silver
Case Owner : e-care Semarang
Detail Complaint : lambat
Additional Information : Dalam rumah ( dalam kamar dan ruang tamu)
Terkenda 1 wilayah
Bukti capture pelanggan : https://prnt.sc/O581ClY2Ztjz
Capture CCA : https://prnt.sc/mD-k_IMqTcnc
Hasil analisa CCA :
Possible Root Cause : Radio_lambat
Remarks : Issue: Quality`;

  const summary = extractCustomerDetailsSummary(bahtiarText, {});
  assert.ok(summary.includes("Nama Customer : BAHTIAR"));
  assert.ok(summary.includes("MSISDN-A Yang Menghubungi : 081265538866"));
  assert.ok(summary.includes("MSISDN-B Yang Bermasalah : 081265969100"));
  assert.ok(summary.includes("Tanggal/Jam Kejadian : 17:00 - 20:00 12/09/2026"));
  assert.ok(summary.includes("Detail Complain : lambat"));
  assert.ok(summary.includes("Capture CCA : https://prnt.sc/mD-k_IMqTcnc"));
});

test("formatRepetitiveEscalationPayload cleanly formats CC-20260910-00000301 without CRM duplication", () => {
  const crmRaw = `[HK][NO][TBL  1-SPGCOPI][ REG][GOLD][CB]
Nama Customer : BP EDY
MSISDN-A Yang Menghubungi : 6282385052355
MSISDN-B Yang Bermasalah :6282385052355
Tanggal/Jam Kejadian :10.00-12.00 10/09/2026
Lokasi Pelanggan (alamat) : kel. jambu tonang, kec. ujung batu, kab, padang laos utara
Koordinat customer :
Segmentasi Kartu : simpati
SIM Capability : USIM
Customer Tier Pelanggan :gold
Case Owner : Call Center bdg
Detail Complain : akses sangat lambat di 11-13.00 hari ini, sinyal bar 2, jaringan E/kosong/, yang berkendala semua nomor tsel, di dalam dan luar ruangan sama saja
Additional Information :
Capture bukti pelanggan : https://prnt.sc/d62adGbAWyrC
Capture CCA : https://prnt.sc/yiG_yVO-CNcr
Possible Root Cause
Kapasitas_jaringan
Remarks
Possible Root Cause
BTS_Down
Remarks
Issue: Availability
Bapak atau Ibu Yth, kendala Bapak atau Ibu yang dialami saat ini sedang dalam proses peningkatan kualitas jaringan dan memerlukan waktu untuk dapat kembali normal.
Mohon dicek secara berkala.
Cause : INAP Site Down
Alarm level : 0
Alarm meaning : 0 = Low, 1 = Critical, 2 = Major, 3 = Minor
Suggestion
TIDAK PERLU CREATE TIKET KE TIM NETWORK. Pelanggan mengalami masalah dan sudah ada tiket yang dicreate ke Network dengan
Ticket No: IM-20260909-00003197
Notes : ybs menghubungi  lagi saat ini 12:21 10/09/2026 ,kendala yg sama dialami oleh ybs. ybs sudah ajukan pelaporan kesekian kalinya, nmn ybs merasa pihak telkomsel hanya mengacuhkan laporan ybs saja tanpa ada tindak lanjut yg serius. Jaringan 4G di lokasi ybs sudah sempat muncul pagi ini10/09/2026, nmn tbtb down kembali dan tidak bs di gunakan sama sekali. Ybs sudah tidak bs toleransi kendala jaringan dan tidak mau menunggu lama untuk proses kendalanya. Ybs meminta pihak telkomsel tangan serius kendala jaringan di lokasi ybs. Ybs meminta tiket tidak di closed sebelum konfirmasi ybs jaringan sudah stabil atau blm cp 6282385052355.co bantu tbl kembali tim moban tks
Lapul :7 
Kategori : Repatcall
#HKNO
#SPECIALCASE`;

  const ticket = {
    order_id: "CC-20260910-00000301",
    city: "PADANG LAWAS UTARA",
    pic_sqa: "Bagus",
    is_repetitive: true,
    resolve_target_22h_text: "Jumat / 11 Sep 2026, 10:34:09 AM",
    raw_description: crmRaw,
    row_raw: {
      Notes: crmRaw,
      "Problem Analysis": `Problem: Terdapat gangguan di BTS, sedang diperbaiki\n\nDISAMPAIKAN HANYA JIKA DIBUTUHKAN\nEstimated Time Resolved: 7x24jam`,
    },
    ccm_analysis: `Problem: Terdapat gangguan di BTS, sedang diperbaiki\n\nDISAMPAIKAN HANYA JIKA DIBUTUHKAN\nEstimated Time Resolved: 7x24jam`,
  };

  const payload = formatRepetitiveEscalationPayload(ticket);

  // Verifikasi header dan mentions
  assert.ok(payload.text.includes("CC-20260910-00000301"));
  assert.ok(payload.text.includes("CC bang @628118035472"));

  // Verifikasi CCM Analysis bersih tanpa teks template call center
  assert.ok(payload.text.includes("CCM Analysis : Problem: Terdapat gangguan di BTS, sedang diperbaiki"));
  assert.ok(!payload.text.includes("DISAMPAIKAN HANYA JIKA DIBUTUHKAN"));
  assert.ok(!payload.text.includes("Estimated Time Resolved"));

  // Verifikasi Note mengekstrak catatan agent call center dan BUKAN mengulang deskripsi CRM
  assert.ok(payload.text.includes("Note : ybs menghubungi  lagi saat ini 12:21 10/09/2026"));
  assert.ok(!payload.text.includes("Note : [HK][NO]"));
  assert.ok(!payload.text.includes("Lapul :7"));
  assert.ok(!payload.text.includes("#HKNO"));
  assert.ok(!payload.text.includes("#SPECIALCASE"));

  // Panjang keseluruhan pesan harus ringkas dan proporsional (tidak ribuan karakter)
  assert.ok(
    payload.text.length < 1600,
    `Payload text length ${payload.text.length} should be under 1600 characters`,
  );
});

test("extractRepetitiveNote ignores full CRM description dumps in row['Notes'] when no note exists", () => {
  const crmWithoutNote = `[HK][NO][TBL  1-SPGCOPI]
Nama Customer : BP EDY
MSISDN-A Yang Menghubungi : 6282385052355
Detail Complain : lambat`;

  const note = extractRepetitiveNote(crmWithoutNote, { Notes: crmWithoutNote });
  assert.equal(note, "-");
});

test("only SQA tickets enter Site Visit; NOP tickets with reopen >= 3 remain in NOP and are not sent to Site Visit", async () => {
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
    { column: "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)", type: String, value: (d) => d.desc },
    { column: "Customer MSISDN(Create Ticket_customer_msisdn)", type: String, value: (d) => d.msisdn },
    { column: "Reopen Number(Confirm Close)", type: String, value: (d) => d.reopenNumber },
    { column: "Resolution(L2 Assign)", type: String, value: (d) => d.resolution },
  ];

  const data = [
    // NOP ticket with reopen = 3: should NOT clone to Site Visit
    {
      orderId: "CC-20260821-00000888",
      ticketId: "1-NOPREOPEN3",
      createTime: "2026-08-21 23:44:50",
      status: "ReOpen",
      group: "Network Operations and Productivity Medan",
      assignL2: "group:Network Operations and Productivity Medan",
      city: "KOTA MEDAN",
      siteId1: "MDN629",
      nsh: "#Site cover  : MDN629",
      cch1: "cause: Radio_Cell_Congestion",
      desc: "Nama Customer : NOP TEST 1\nMSISDN-A : 62822000001",
      msisdn: "62822000001",
      reopenNumber: "3",
      resolution: "Investigating BTS",
    },
    // NOP ticket with reopen = 5 (> 3): should NOT route to Site Visit, must remain NOP
    {
      orderId: "CC-20260821-00000889",
      ticketId: "1-NOPREOPEN5",
      createTime: "2026-08-21 23:44:50",
      status: "ReOpen",
      group: "Network Operations and Productivity Binjai",
      assignL2: "group:Network Operations and Productivity Binjai",
      city: "LANGKAT",
      siteId1: "BJI182",
      nsh: "#Site cover  : BJI182",
      cch1: "cause: Radio_Cell_Congestion",
      desc: "Nama Customer : NOP TEST 2\nMSISDN-A : 62822000002",
      msisdn: "62822000002",
      reopenNumber: "5",
      resolution: "Investigating Fiber Cut",
    },
    // SQA ticket with reopen = 4 (> 3): SHOULD route to Site Visit
    {
      orderId: "CC-20260821-00000890",
      ticketId: "1-SQAREOPEN4",
      createTime: "2026-08-21 23:44:50",
      status: "ReOpen",
      group: "Service Quality Assurance Sumbagut",
      assignL2: "group:Service Quality Assurance Sumbagut",
      city: "KOTA MEDAN",
      siteId1: "MDN629",
      nsh: "#Site cover  : MDN629",
      cch1: "cause: Radio_Cell_Congestion",
      desc: "Nama Customer : SQA TEST\nMSISDN-A : 62822000003",
      msisdn: "62822000003",
      reopenNumber: "4",
      resolution: "Performance KPI Normal",
    },
  ];

  const buffer = await writeXlsxFile(data, { schema, buffer: true });
  const result = await processTicketExcel(buffer, {
    hasBeenSentToSqa: (id) => id === "CC-20260821-00000890",
  });

  assert.equal(result.ok, true);
  // Total valid tickets: exactly 3 (2 NOP tickets + 1 SQA ticket routed to Site Visit)
  assert.equal(result.valid_tickets.length, 3);

  // NOP ticket 1 (reopen 3): is NOP, not repetitive, not Site Visit
  const nop1 = result.valid_tickets.find((t) => t.order_id === "CC-20260821-00000888");
  assert.ok(nop1);
  assert.equal(nop1.assignment_type, "NOP");
  assert.equal(Boolean(nop1.is_repetitive), false);
  assert.notEqual(nop1.targetGroupKey, "SITE VISIT");
  assert.equal(getTargetGroupKey(nop1), "NOP MEDAN");

  // NOP ticket 2 (reopen 5): is NOP, not repetitive, not Site Visit
  const nop2 = result.valid_tickets.find((t) => t.order_id === "CC-20260821-00000889");
  assert.ok(nop2);
  assert.equal(nop2.assignment_type, "NOP");
  assert.equal(Boolean(nop2.is_repetitive), false);
  assert.notEqual(nop2.targetGroupKey, "SITE VISIT");
  assert.equal(getTargetGroupKey(nop2), "NOP BINJAI");

  // SQA ticket (reopen 4): IS Site Visit
  const sqa1 = result.valid_tickets.find((t) => t.order_id === "CC-20260821-00000890");
  assert.ok(sqa1);
  assert.equal(sqa1.is_repetitive, true);
  assert.equal(sqa1.targetGroupKey, "SITE VISIT");
  assert.equal(getTargetGroupKey(sqa1), "SITE VISIT");

  // Report only lists SQA repetitive ticket in repetitive section, NOT the NOP tickets
  const report = formatProcessingReport(result);
  const repetitiveSection = (report.split("Tiket Repetitif")[1] || "").split("Tiket Anomali")[0];
  assert.ok(repetitiveSection.includes("CC-20260821-00000890"));
  assert.ok(!repetitiveSection.includes("CC-20260821-00000888"));
  assert.ok(!repetitiveSection.includes("CC-20260821-00000889"));
});

test("SQA ticket with ReOpen > 3 that has NEVER been sent to SQA routes to SQA in full format and clones to Site Visit", async () => {
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
    { column: "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)", type: String, value: (d) => d.desc },
    { column: "Customer MSISDN(Create Ticket_customer_msisdn)", type: String, value: (d) => d.msisdn },
    { column: "Reopen Number(Confirm Close)", type: String, value: (d) => d.reopenNumber },
    { column: "Resolution(L2 Assign)", type: String, value: (d) => d.resolution },
  ];

  const data = [
    {
      orderId: "CC-20261002-00000396",
      ticketId: "1-T6HRXQ0",
      createTime: "2026-10-02 23:38:19",
      status: "ReOpen",
      group: "Service Quality Assurance Sumbagut",
      assignL2: "group:Service Quality Assurance Sumbagut",
      city: "PADANG LAWAS UTARA",
      siteId1: "RAP272",
      nsh: "#Site Cover : RAP272\n\nE_RAP272SR1_JAMBUTONANG-DMT_SR32 (+- M)\nRSRP: -105.00dBm(Fair) RSRQ :-9.50 dB()\n\nHEALTHY CHECK :\nAll Safe\n\nSUSPECT ISSUE :\n#Coverage Issue\n\nACTION PLAN :\n- Optim",
      cch1: "cause: eNodeB_ServingSite_Down, suggestion: Known Issues. Already have ticket.",
      desc: "Tanggal Kejadian: 20261002 18:00:00:0000\nNama Customer : BP EDY\nMSISDN-A : 6282385052355\nLokasi Pelanggan (alamat) : kel. jambu tonang, kec. ujung batu, kab, padang laos utara\nDetail Complain : akses sangat lambat",
      msisdn: "6282385052355",
      reopenNumber: "4",
      resolution: "Investigating BTS",
    },
  ];

  const buffer = await writeXlsxFile(data, { schema, buffer: true });
  // CC-20261002-00000396 belum pernah dikirim
  const result = await processTicketExcel(buffer, {
    sentTicketStore: { tickets: {} },
  });

  assert.equal(result.ok, true);
  // Valid tickets: 1 SQA main ticket + 1 Site Visit clone
  assert.equal(result.valid_tickets.length, 2);

  // Main SQA ticket
  const sqaTicket = result.valid_tickets.find(
    (t) => t.order_id === "CC-20261002-00000396" && t.assignment_type === "SQA" && !t.is_repetitive,
  );
  assert.ok(sqaTicket, "Main SQA ticket must exist and NOT be marked repetitive exclusive");
  assert.equal(sqaTicket.targetGroupKey, null);
  assert.equal(sqaTicket.use_reopen_message_format, false, "Must use full complete ticket format");
  assert.match(sqaTicket.anomaly_info, /Belum Pernah Dikirim ke SQA/);

  // Site Visit clone
  const siteVisitClone = result.valid_tickets.find(
    (t) => t.order_id === "CC-20261002-00000396" && t.targetGroupKey === "SITE VISIT",
  );
  assert.ok(siteVisitClone, "Site Visit clone must exist");
  assert.equal(siteVisitClone.is_repetitive, true);
  assert.equal(siteVisitClone.ts_site_visit?.[0]?.name, "Jhonson Ambarita");
  assert.equal(siteVisitClone.ts_site_visit?.[0]?.phone, "6285211739444");

  // Verifikasi format pesan lengkap SQA
  const payload = formatEscalationMessagePayload(sqaTicket);
  assert.ok(payload.text.includes("Mohon dibantu bang"));
  assert.ok(payload.text.includes("CC-20261002-00000396"));
  assert.ok(payload.text.includes("Tanggal Kejadian: 20261002"));
  assert.ok(payload.text.includes("Detail Complain : akses sangat lambat"));
  assert.ok(payload.text.includes("SLA DUE DATE 24H"));

  // Verifikasi format pesan Site Visit menyebut Jhonson Ambarita
  const siteVisitPayload = formatRepetitiveEscalationPayload(siteVisitClone);
  assert.ok(siteVisitPayload.text.includes("6285211739444"));
});



