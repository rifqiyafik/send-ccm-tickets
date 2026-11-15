import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { closeDatabasePool } from "../src/services/databaseService.js";

import {
  isWithinWorkingHours,
  convertDbRowToTicketRow,
  getWibDateString,
  getDefaultWatermark,
  loadPollWatermark,
  savePollWatermark,
  formatPreSendNotification,
  formatSentTicketsNotificationTable,
  formatSkippedTicketsAlertNotification,
  createTicketPollingService,
} from "../src/services/ticketPollingService.js";

test("isWithinWorkingHours correctly checks 07:00 to 17:00 WIB", () => {
  // 08:00 WIB = 01:00 UTC
  const morningWib = new Date("2026-09-11T01:00:00.000Z");
  assert.equal(isWithinWorkingHours(morningWib), true);

  // 16:59 WIB = 09:59 UTC
  const eveningWib = new Date("2026-09-11T09:59:00.000Z");
  assert.equal(isWithinWorkingHours(eveningWib), true);

  // 17:01 WIB = 10:01 UTC -> Outside working hours
  const nightWib = new Date("2026-09-11T10:01:00.000Z");
  assert.equal(isWithinWorkingHours(nightWib), false);

  // 06:30 WIB = 23:30 UTC previous day -> Outside working hours
  const earlyWib = new Date("2026-09-10T23:30:00.000Z");
  assert.equal(isWithinWorkingHours(earlyWib), false);
});

test("convertDbRowToTicketRow maps ClickHouse snake_case columns to canonical Excel keys", () => {
  const dbRow = {
    order_id: "CC-20260911-00000101",
    ticket_id: "TCK-101",
    create_time: "2026-09-11 08:30:00",
    business_status: "L2 Assign",
    assignment_group: "SQA",
    city: "KOTA MEDAN",
    site_id1: "MDN001",
    problem_analysis_nsh: "Normal issue",
    customer_msisdn: "08123456789",
    description_fault_symptomps: "Koneksi lambat",
  };

  const converted = convertDbRowToTicketRow(dbRow);
  assert.equal(converted["Order ID"], "CC-20260911-00000101");
  assert.equal(converted["Ticket Id"], "TCK-101");
  assert.equal(converted["Create Time"], "2026-09-11 08:30:00");
  assert.equal(converted["Business Status"], "L2 Assign");
  assert.equal(
    converted["Assignment Group"],
    "SERVICE QUALITY ASSURANCE SUMBAGUT",
  );
  assert.equal(converted["City"], "KOTA MEDAN");
  assert.equal(converted["Site ID 1"], "MDN001");
  assert.equal(converted["Problem Analysis NSH"], "Normal issue");
  assert.equal(converted["Customer MSISDN"], "08123456789");
  assert.equal(
    converted[
      "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)"
    ],
    "Koneksi lambat",
  );
});

test("convertDbRowToTicketRow maps live ClickHouse schema columns correctly", () => {
  const chRow = {
    order_id: "CC-20260913-00000062",
    ticket_id: "000000620364d92e81-cafc-1cf0-2994-3f39de0c1644",
    create_time: "2026-09-13 03:51:07",
    business_status: "BusinessStatusInProgress",
    assign_to_l2: "group:Network Operations and Productivity Pematangsiantar",
    kabupaten_kota_create_ticket: "KOTA PEMATANGSIANTAR",
    site_id_2_l2_assign: "PMR004",
    problem_analysis_nsh: "Lokasi: Jln viyata Yudha...",
    cch_suggestion_l1_assign: "cause: Network_low_speed...",
    description_fault_sumptomps_create_ticket: "Tanggal Kejadian: 20260912\nDetail Complain : jaringan lemot",
    customer_msisdn_create_ticket: "628137363155",
    problem_start_time_create_ticket: "2026-09-12 20:51:07",
    customer_interaction_date_create_ticket: "2026-09-12 20:51:07",
  };

  const converted = convertDbRowToTicketRow(chRow);
  assert.equal(converted["Order ID"], "CC-20260913-00000062");
  assert.equal(converted["Assignment Group"], "NETWORK OPERATIONS AND PRODUCTIVITY PEMATANGSIANTAR");
  assert.equal(converted["City"], "KOTA PEMATANGSIANTAR");
  assert.equal(converted["Site ID 1"], "PMR004");
  assert.equal(converted["Customer MSISDN"], "628137363155");
  assert.equal(converted["Problem Start Time"], "2026-09-12 20:51:07");
  assert.equal(converted["Customer Interaction Date"], "2026-09-12 20:51:07");
  assert.equal(
    converted["Description Fault Sumptomps(Create Ticket_description__fault_symptomps)"],
    "Tanggal Kejadian: 20260912\nDetail Complain : jaringan lemot",
  );
});

test("loadPollWatermark and savePollWatermark manage watermark state correctly", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "poll-watermark-"));
  const tempFile = path.join(tempDir, "watermark.json");

  try {
    // 1. Initial state when file does not exist
    const initial = await loadPollWatermark(tempFile);
    assert.equal(initial.lastPollTime, null);
    assert.ok(initial.lastWatermark.includes("00:00:00"));
    assert.equal(initial.totalSentToday, 0);

    // 2. Save state
    await savePollWatermark(
      {
        lastPollTime: "2026-09-11T09:00:00.000Z",
        lastWatermark: "2026-09-11 09:00:00",
        todayDate: getWibDateString(),
        totalSentToday: 5,
      },
      tempFile,
    );

    // 3. Reload state
    const reloaded = await loadPollWatermark(tempFile);
    assert.equal(reloaded.lastPollTime, "2026-09-11T09:00:00.000Z");
    assert.equal(reloaded.lastWatermark, "2026-09-11 09:00:00");
    assert.equal(reloaded.totalSentToday, 5);

    // 4. Reload on a different day resets totalSentToday
    await savePollWatermark(
      {
        lastPollTime: "2026-09-10T09:00:00.000Z",
        lastWatermark: "2026-09-10 09:00:00",
        todayDate: "2026-09-10",
        totalSentToday: 10,
      },
      tempFile,
    );

    const nextDayReload = await loadPollWatermark(tempFile);
    assert.equal(nextDayReload.totalSentToday, 0, "New day should reset totalSentToday");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("formatPreSendNotification and formatSentTicketsNotificationTable format notifications properly", () => {
  const sampleTickets = [
    {
      order_id: "CC-20260911-00000501",
      city: "KOTA MEDAN",
      cluster_area: "NOP MEDAN",
      sla_status: "OUT SLA",
      pic: "Ahsan",
      site_id: "MDN084",
    },
  ];

  const preSend = formatPreSendNotification(sampleTickets);
  assert.ok(preSend.includes("🔔"));
  assert.ok(preSend.includes("1 Tiket Baru"));
  assert.ok(preSend.includes("CC-20260911-00000501"));

  const summary = formatSentTicketsNotificationTable(sampleTickets);
  assert.ok(summary.includes("Tiket Baru Terkirim Otomatis"));
  assert.ok(summary.includes("CC-20260911-00000501"));
  assert.ok(summary.includes("KOTA MEDAN"));
  assert.ok(summary.includes("Ahsan"));
  assert.ok(summary.includes("Total: **1 tiket**"));
});

test("createTicketPollingService manages polling lifecycle and dispatches tickets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "polling-service-"));
  const watermarkFile = path.join(tempDir, "watermark.json");
  const originalStorePath = process.env.SENT_TICKET_STORE_PATH;
  const originalDelay = process.env.WA_SEND_DELAY_MS;
  const originalMinDelay = process.env.WA_SEND_DELAY_MIN_MS;
  const originalMaxDelay = process.env.WA_SEND_DELAY_MAX_MS;

  process.env.SENT_TICKET_STORE_PATH = path.join(tempDir, "sent_tickets.json");
  process.env.WA_SEND_DELAY_MS = "1";
  process.env.WA_SEND_DELAY_MIN_MS = "1";
  process.env.WA_SEND_DELAY_MAX_MS = "1";

  const sentTelegramMessages = [];
  const fakeTelegramBot = {
    async sendMessage(chatId, text, options) {
      sentTelegramMessages.push({ chatId, text, options });
    },
  };

  const today = getWibDateString();
  const fakeDbRows = [
    {
      order_id: "CC-20260911-00000999",
      ticket_id: "TCK-999",
      create_time: `${today} 10:00:00`,
      business_status: "L2 Assign",
      assignment_group: "SQA",
      city: "KOTA MEDAN",
      site_id1: "MDN999",
      problem_analysis_nsh: "NSH Problem",
      customer_msisdn: "0812999999",
      description_fault_symptomps: "Lambat",
    },
  ];

  let dispatchCalled = false;
  let dispatchedTickets = [];

  const fakeAdapter = {
    sourceJid: "telegram:12345",
    async sendMessage() {},
    async sendPresenceUpdate() {},
  };

  const service = createTicketPollingService({
    telegramBot: fakeTelegramBot,
    adminChatIds: ["12345"],
    watermarkPath: watermarkFile,
    createAdapter: () => fakeAdapter,
    fetchTickets: async () => fakeDbRows,
    pingDb: async () => ({ ok: true, success: true }),
    includeAuthorizedGroups: false,
  });

  try {
    // 1. Check status initially
    const status = await service.getStatus();
    assert.equal(status.dbConnected, true);
    assert.equal(status.isPaused, false);
    assert.equal(status.totalSentToday, 0);

    // 2. Pause and resume
    service.pause();
    const pausedStatus = await service.getStatus();
    assert.equal(pausedStatus.isPaused, true);

    const pausedPollResult = await service.poll();
    assert.equal(pausedPollResult.status, "PAUSED");

    service.resume();
    const resumedStatus = await service.getStatus();
    assert.equal(resumedStatus.isPaused, false);

    // 3. Poll with force=true (simulates /poll now)
    const result = await service.poll({ force: true });
    assert.equal(result.status, "SUCCESS");
    assert.equal(result.newTickets, 1);

    // Verify pre-send notification and summary table were sent to Telegram
    assert.ok(sentTelegramMessages.length >= 2);
    assert.ok(sentTelegramMessages[0].text.includes("Ditemukan 1 Tiket Baru"));
    assert.ok(sentTelegramMessages[1].text.includes("Tiket Baru Terkirim Otomatis"));
    assert.ok(sentTelegramMessages[1].text.includes("CC-20260911-00000999"));

    // Verify watermark was updated
    const finalState = await loadPollWatermark(watermarkFile);
    assert.equal(finalState.totalSentToday, 1);
    assert.equal(finalState.lastWatermark, `${today} 10:00:00`);
  } finally {
    service.stop();
    if (originalStorePath !== undefined) {
      process.env.SENT_TICKET_STORE_PATH = originalStorePath;
    } else {
      delete process.env.SENT_TICKET_STORE_PATH;
    }
    if (originalDelay !== undefined) {
      process.env.WA_SEND_DELAY_MS = originalDelay;
    } else {
      delete process.env.WA_SEND_DELAY_MS;
    }
    if (originalMinDelay !== undefined) {
      process.env.WA_SEND_DELAY_MIN_MS = originalMinDelay;
    } else {
      delete process.env.WA_SEND_DELAY_MIN_MS;
    }
    if (originalMaxDelay !== undefined) {
      process.env.WA_SEND_DELAY_MAX_MS = originalMaxDelay;
    } else {
      delete process.env.WA_SEND_DELAY_MAX_MS;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("createTicketPollingService sends notifications to both admin and authorized groups", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "polling-groups-"));
  const watermarkFile = path.join(tempDir, "watermark.json");
  const originalDelay = process.env.WA_SEND_DELAY_MS;
  const originalMinDelay = process.env.WA_SEND_DELAY_MIN_MS;
  const originalMaxDelay = process.env.WA_SEND_DELAY_MAX_MS;

  const originalStorePath = process.env.SENT_TICKET_STORE_PATH;

  process.env.SENT_TICKET_STORE_PATH = path.join(tempDir, "sent_tickets.json");
  process.env.WA_SEND_DELAY_MS = "1";
  process.env.WA_SEND_DELAY_MIN_MS = "1";
  process.env.WA_SEND_DELAY_MAX_MS = "1";

  const sentMessages = [];
  const fakeTelegramBot = {
    async sendMessage(chatId, text, options) {
      sentMessages.push({ chatId, text, options });
    },
  };

  const today = getWibDateString();
  const fakeDbRows = [
    {
      order_id: "CC-20260914-00000001",
      ticket_id: "TCK-100",
      create_time: `${today} 10:00:00`,
      business_status: "L2 Assign",
      assignment_group: "SQA",
      city: "KOTA MEDAN",
      site_id1: "MDN001",
      problem_analysis_nsh: "NSH Problem",
      customer_msisdn: "0812999999",
      description_fault_symptomps: "Lambat",
    },
  ];

  const fakeAdapter = {
    sourceJid: "telegram:5085979770",
    async sendMessage() {},
    async sendPresenceUpdate() {},
  };

  const service = createTicketPollingService({
    telegramBot: fakeTelegramBot,
    adminChatIds: ["5085979770"],
    getRecipientChatIds: async () => ["5085979770", "-1004440463334"],
    watermarkPath: watermarkFile,
    createAdapter: () => fakeAdapter,
    fetchTickets: async () => fakeDbRows,
    pingDb: async () => ({ ok: true, success: true }),
  });

  try {
    const result = await service.poll({ force: true });
    assert.equal(result.status, "SUCCESS");
    assert.equal(result.newTickets, 1);

    // Verify messages were delivered to both admin and the authorized group -1004440463334
    const adminMsgs = sentMessages.filter((m) => m.chatId === "5085979770");
    const groupMsgs = sentMessages.filter((m) => m.chatId === "-1004440463334");

    assert.ok(adminMsgs.length >= 2, "Admin should receive pre-send and summary");
    assert.ok(groupMsgs.length >= 2, "Authorized group should receive pre-send and summary");
    assert.ok(groupMsgs[0].text.includes("Ditemukan 1 Tiket Baru"));
    assert.ok(groupMsgs[1].text.includes("Tiket Baru Terkirim Otomatis"));
  } finally {
    service.stop();
    if (originalStorePath !== undefined) {
      process.env.SENT_TICKET_STORE_PATH = originalStorePath;
    } else {
      delete process.env.SENT_TICKET_STORE_PATH;
    }
    if (originalDelay !== undefined) {
      process.env.WA_SEND_DELAY_MS = originalDelay;
    } else {
      delete process.env.WA_SEND_DELAY_MS;
    }
    if (originalMinDelay !== undefined) {
      process.env.WA_SEND_DELAY_MIN_MS = originalMinDelay;
    } else {
      delete process.env.WA_SEND_DELAY_MIN_MS;
    }
    if (originalMaxDelay !== undefined) {
      process.env.WA_SEND_DELAY_MAX_MS = originalMaxDelay;
    } else {
      delete process.env.WA_SEND_DELAY_MAX_MS;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("formatSkippedTicketsAlertNotification formats notification with site, reason, and region recommendation", () => {
  const sampleTickets = [
    {
      order_id: "CC-20260917-00000005",
      reason: "SITE_COVER_NOT_FOUND_IN_NOP_DATA",
      site_id: "-",
      detected_site: "E_JKT388MT1_Gedungbrantas_MT03",
      city: "-",
      customer_address: "jakarta timur cawang jatinegara",
      is_out_of_region: true,
      suspected_region: "Regional Jabotabek (Site Prefix: JKT)",
      recommendation:
        "Mohon cek CRM dan eskalasi/reassign ke Regional Jabotabek jika tiket ini salah terlempar ke Sumbagut.",
    },
  ];

  const messages = formatSkippedTicketsAlertNotification(sampleTickets);
  assert.equal(messages.length, 1);
  const msg = messages[0];
  assert.match(msg, /🚨 \*PERHATIAN: TIKET GAGAL DIPROSES \/ DILUAR REGIONAL\*/);
  assert.match(msg, /Order ID\*: `CC-20260917-00000005`/);
  assert.match(msg, /Alasan\*: `SITE_COVER_NOT_FOUND_IN_NOP_DATA`/);
  assert.match(msg, /Site\*: `E_JKT388MT1_Gedungbrantas_MT03`/);
  assert.match(msg, /Alamat\/Kota\*: jakarta timur cawang jatinegara/);
  assert.match(msg, /Indikasi Wilayah\*: \*Regional Jabotabek/);
  assert.match(msg, /⚠️ \*Rekomendasi\*: Mohon cek CRM/);
});

test("poll cycle does not send Telegram notification for skipped/out-of-region tickets (reserved for CSV/Excel)", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "db-poll-skipped-"));
  const watermarkFile = path.join(tempDir, "watermark.json");

  const sentTelegramMessages = [];
  const fakeTelegramBot = {
    async sendMessage(chatId, text, options) {
      sentTelegramMessages.push({ chatId, text, options });
    },
  };

  const today = getWibDateString();
  const fakeOutOfRegionRows = [
    {
      order_id: "CC-20260917-00000005",
      ticket_id: "0000000503650eb8e6-7ce1-27ee-13ea-44a3628e9c40",
      create_time: `${today} 09:15:00`,
      business_status: "BusinessStatusInProgress",
      assign_to_l2: "group:Network Operations and Productivity Sumbagut",
      kabupaten_kota_create_ticket: "-",
      site_id_2_l2_assign: "-",
      problem_analysis_nsh:
        "Problem: Terdapat gangguan di BTS...\nSite Cover: E_JKT388MT1_Gedungbrantas_MT03\nSymptom: Internet Slow",
      description_fault_sumptomps_create_ticket:
        "Tanggal Kejadian : 16/09/2026 Lokasi Pelanggan (alamat) : jakarta timur cawang detil itu aja jatinegara",
      customer_msisdn_create_ticket: "6285363181625",
    },
  ];

  const service = createTicketPollingService({
    telegramBot: fakeTelegramBot,
    adminChatIds: ["5085979770"],
    getRecipientChatIds: async () => ["5085979770"],
    includeAuthorizedGroups: false,
    watermarkPath: watermarkFile,
    useDatabase: false,
    fetchTickets: async () => fakeOutOfRegionRows,
    pingDb: async () => ({ ok: true, success: true }),
  });

  try {
    const pollResult = await service.poll({ force: true });
    assert.equal(pollResult.status, "NO_VALID_TICKETS");
    assert.equal(pollResult.newTickets, 0);

    // Pastikan tidak ada pesan peringatan yang dikirim ke Telegram dari DB polling
    const alertMsgs = sentTelegramMessages.filter((m) =>
      m.text.includes("PERHATIAN: TIKET GAGAL DIPROSES / DILUAR REGIONAL"),
    );
    assert.equal(alertMsgs.length, 0);
    assert.equal(sentTelegramMessages.length, 0);
  } finally {
    service.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

after(async () => {
  await closeDatabasePool();
});


