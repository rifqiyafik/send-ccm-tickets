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
  const result = await processTicketExcel(buffer);

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
    (m) => m.jid === "120363000000000099@g.us" || m.jid.includes("g.us") || m.jid.startsWith("manual:"),
  );
  assert.ok(siteVisitMsg, "Site Visit message was sent");
  assert.ok(siteVisitMsg.payload.text.includes("Ticket Complain Repetitif"));
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
