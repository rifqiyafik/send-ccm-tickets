import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { sendImportResult } from "../src/handlers/whatsappMessageHandler.js";

function setupConfig() {
  const tmpDir = path.join("tmp", "summary-mode-routing");
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
          SQA: {
            jid: "120363000000000001@g.us",
            label: "SQA Target",
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

    assert.equal(sourceReminder, undefined);
    assert.ok(targetReminder);
    assert.match(targetReminder.payload.text, /SQA \| 1 \| 1 \| 0/);
  } finally {
    context.cleanup();
  }
});
