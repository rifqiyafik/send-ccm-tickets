import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { sendImportResult } from "../src/handlers/whatsappMessageHandler.js";

function setupConfig() {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = path.resolve("tmp", `summary-mode-routing-${uniqueId}`);
  const configPath = path.join(tmpDir, "whatsapp.json");
  const sentStorePath = path.join(tmpDir, "sent_tickets.json");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        authorized_groups: {},
        authorized_users: {},
        target_groups: {
          "MAIN SQA": {
            jid: "120363000000000999@g.us",
            label: "Main SQA",
          },
          SQA: {
            jid: "120363000000000001@g.us",
            label: "SQA Target",
          },
          "SITE VISIT": {
            jid: "120363000000000888@g.us",
            label: "Site Visit Target",
          },
        },
        mentions: {},
      },
      null,
      2,
    ),
  );
  process.env.WHATSAPP_CONFIG_PATH = configPath;
  process.env.SENT_TICKET_STORE_PATH = sentStorePath;

  return {
    targetJid: "120363000000000001@g.us",
    mainSqaJid: "120363000000000999@g.us",
    siteVisitJid: "120363000000000888@g.us",
    cleanup() {
      delete process.env.WHATSAPP_CONFIG_PATH;
      delete process.env.SENT_TICKET_STORE_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function createResult() {
  const ticket = {
    assignment_type: "SQA",
    assignment_group: "SERVICE QUALITY ASSURANCE SUMBAGUT",
    sla_status: "IN SLA",
    business_status: "IN PROGRESS",
    departement_ns: "NOP ACEH",
    city: "ACEH BESAR",
    order_id: "CC-20260724-00000001",
    site_id: "JHO293",
    reopen_number: "1",
    problem_analysis:
      "Performance KPI beberapa hari terakhir disaat kejadian terlihat Normal.",
    resolve_target_22h_text: "Jumat / 24 Jul 2026, 10:00:00 AM",
    ccm_handling: "Ferry",
    pic_sqa: "Herman",
    notes: "Tanggal Kejadian: 20260724 08:00:00:0000",
    analysis_text: "cause: Coverage",
    pic: "Herman",
  };

  return {
    ok: true,
    total_rows: 1,
    valid_count: 1,
    skipped_count: 0,
    valid_tickets: [ticket],
    skipped_tickets: [],
    grouped_tickets: { SQA: [ticket] },
    processing_log: [],
    skipped_by_reason: {},
    valid_by_pic: { Herman: 1 },
    valid_by_assignment_type: { SQA: 1 },
  };
}

test(".summary sends reminder to WhatsApp target group instead of source chat", async () => {
  const context = setupConfig();
  const sentMessages = [];
  const sock = {
    async sendMessage(jid, payload) {
      sentMessages.push({ jid, payload });
    },
  };

  try {
    await sendImportResult(sock, "telegram:5085979770", createResult(), {
      summaryOnlyMode: true,
    });

    const sourceReminder = sentMessages.find(
      (message) =>
        message.jid === "telegram:5085979770" &&
        /Remind Ticket CX Open/.test(message.payload?.text || ""),
    );
    const targetReminder = sentMessages.find(
      (message) =>
        message.jid === context.targetJid &&
        /Remind Ticket CX Open/.test(message.payload?.text || ""),
    );
    const mainSqaReminder = sentMessages.find(
      (message) =>
        message.jid === context.mainSqaJid &&
        /Remind Ticket CX Open/.test(message.payload?.text || ""),
    );

    assert.equal(sourceReminder, undefined);
    assert.equal(targetReminder, undefined);
    assert.ok(mainSqaReminder);
    assert.match(mainSqaReminder.payload.text, /SQA \| 1 \| 1 \| 0/);
  } finally {
    context.cleanup();
  }
});

test("normal import sends SQA reminder only to MAIN SQA, not SQA detail group", async () => {
  const context = setupConfig();
  const sentMessages = [];
  const sock = {
    async sendMessage(jid, payload) {
      sentMessages.push({ jid, payload });
    },
  };

  try {
    await sendImportResult(sock, "telegram:5085979770", createResult());

    const sqaTargetReminder = sentMessages.find(
      (message) =>
        message.jid === context.targetJid &&
        /Remind Ticket CX Open/.test(message.payload?.text || ""),
    );
    const mainSqaReminder = sentMessages.find(
      (message) =>
        message.jid === context.mainSqaJid &&
        /Remind Ticket CX Open/.test(message.payload?.text || ""),
    );
    const sqaTargetTicket = sentMessages.find(
      (message) =>
        message.jid === context.targetJid &&
        /Mohon dibantu bang/.test(message.payload?.text || ""),
    );

    assert.equal(sqaTargetReminder, undefined);
    assert.ok(mainSqaReminder);
    assert.ok(sqaTargetTicket);
  } finally {
    context.cleanup();
  }
});

test("normal import sends daily In Progress reminder only to SQA/NOP target, not MAIN SQA", async () => {
  const context = setupConfig();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayIso = yesterday.toISOString();
  const yesterdayDate = yesterdayIso.slice(0, 10);
  fs.writeFileSync(
    process.env.SENT_TICKET_STORE_PATH,
    JSON.stringify(
      {
        version: 1,
        tickets: {
          "CC-20260724-00000001": {
            order_id: "CC-20260724-00000001",
            business_status: "IN PROGRESS",
            sla_status: "IN SLA",
            sent_at: yesterdayIso,
            sent_date: yesterdayDate,
          },
        },
      },
      null,
      2,
    ),
  );
  const sentMessages = [];
  const sock = {
    async sendMessage(jid, payload) {
      sentMessages.push({ jid, payload });
    },
  };

  try {
    await sendImportResult(sock, "telegram:5085979770", createResult());

    const targetDailyReminder = sentMessages.find(
      (message) =>
        message.jid === context.targetJid &&
        (/REMIND TICKET IN PROGRESS/.test(message.payload?.text || "") ||
          /Izin mengingatkan/.test(message.payload?.text || "")),
    );
    const mainSqaDailyReminder = sentMessages.find(
      (message) =>
        message.jid === context.mainSqaJid &&
        (/REMIND TICKET IN PROGRESS/.test(message.payload?.text || "") ||
          /Izin mengingatkan/.test(message.payload?.text || "")),
    );
    const sqaTargetTicket = sentMessages.find(
      (message) =>
        message.jid === context.targetJid &&
        /Mohon dibantu bang/.test(message.payload?.text || ""),
    );

    assert.ok(targetDailyReminder);
    assert.equal(mainSqaDailyReminder, undefined);
    assert.equal(sqaTargetTicket, undefined);
  } finally {
    context.cleanup();
  }
});

test(".summary consolidates regular SQA and repetitive SQA into ONE single summary for MAIN SQA, and sends 0 summary to SITE VISIT", async () => {
  const context = setupConfig();
  const sentMessages = [];
  const sock = {
    async sendMessage(jid, payload) {
      sentMessages.push({ jid, payload });
    },
  };

  const regularSqaTicket = {
    assignment_type: "SQA",
    assignment_group: "SERVICE QUALITY ASSURANCE SUMBAGUT",
    sla_status: "IN SLA",
    business_status: "IN PROGRESS",
    departement_ns: "NOP ACEH",
    city: "ACEH BESAR",
    order_id: "CC-20260724-00000001",
    site_id: "JHO293",
    reopen_number: "1",
    problem_analysis: "KPI Normal",
    resolve_target_22h_text: "Jumat / 24 Jul 2026, 10:00:00 AM",
    ccm_handling: "Ferry",
    pic_sqa: "Herman",
    notes: "Tanggal Kejadian: 20260724 08:00:00:0000",
    analysis_text: "cause: Coverage",
    pic: "Herman",
  };

  const repetitiveSqaTicket = {
    assignment_type: "SQA",
    assignment_group: "SERVICE QUALITY ASSURANCE SUMBAGUT",
    sla_status: "OUT SLA",
    business_status: "IN PROGRESS",
    departement_ns: "NOP MEDAN",
    city: "MEDAN",
    order_id: "CC-20260820-00000579",
    site_id: "MDN442",
    reopen_number: "4",
    is_repetitive: true,
    reopen_count: 4,
    problem_analysis: "KPI Normal tidak ada anomali",
    resolve_target_22h_text: "Kamis / 20 Aug 2026, 10:00:00 AM",
    ccm_handling: "Ferry",
    pic_sqa: "Dedi",
    notes: "Tanggal Kejadian: 20260820 08:00:00:0000",
    analysis_text: "cause: Capacity",
    pic: "Dedi",
  };

  const testResult = {
    ok: true,
    total_rows: 2,
    valid_count: 2,
    skipped_count: 0,
    valid_tickets: [regularSqaTicket, repetitiveSqaTicket],
    skipped_tickets: [],
    grouped_tickets: { SQA: [regularSqaTicket, repetitiveSqaTicket] },
    processing_log: [],
    skipped_by_reason: {},
    valid_by_pic: { Herman: 1, Dedi: 1 },
    valid_by_assignment_type: { SQA: 2 },
  };

  try {
    await sendImportResult(sock, "telegram:5085979770", testResult, {
      summaryOnlyMode: true,
    });

    const summaryMessages = sentMessages.filter((msg) =>
      /Remind Ticket CX Open/i.test(msg.payload?.text || ""),
    );

    // Harus TEPAT SATU summary yang dikirim untuk SQA (bukan 2 kali)
    const mainSqaSummaries = summaryMessages.filter(
      (msg) => msg.jid === context.mainSqaJid,
    );
    assert.equal(
      mainSqaSummaries.length,
      1,
      "MAIN SQA harus menerima tepat 1 pesan summary SQA, tidak boleh duplikat/terpecah",
    );

    // Summary tersebut harus menggabungkan seluruh 2 tiket (1 In SLA + 1 Out SLA)
    assert.match(
      mainSqaSummaries[0].payload.text,
      /SQA \| 2 \| 1 \| 1/,
      "Summary SQA harus mencakup total 2 tiket (gabungan tiket reguler dan repetitif)",
    );

    // SITE VISIT sama sekali TIDAK boleh menerima pesan summary
    const siteVisitSummaries = summaryMessages.filter(
      (msg) => msg.jid === context.siteVisitJid,
    );
    assert.equal(
      siteVisitSummaries.length,
      0,
      "Grup SITE VISIT tidak boleh menerima pesan summary",
    );
  } finally {
    context.cleanup();
  }
});

