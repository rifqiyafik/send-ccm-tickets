import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createSentTicketPlan,
  markTicketAsSent,
} from "../src/services/sentTicketService.js";
import { formatEscalationMessagePayload } from "../src/services/ticketImportService.js";

test("Escalated Reassignment: Detects cross-assignment transfer from NOP to SQA", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "escalate-test-"));
  const tmpStore = path.join(tmpDir, "sent_tickets.json");
  process.env.SENT_TICKET_STORE_PATH = tmpStore;

  try {
    // 1. Initial state: Ticket was sent yesterday to NOP ACEH
    const initialTicket = {
      order_id: "CC-20260815-00000323",
      assignment_type: "NOP",
      assignment_group: "Network Operations and Productivity Banda Aceh",
      cluster_area: "NOP ACEH",
      business_status: "InProgress",
      sla_status: "IN SLA",
      reopen_number: "-",
      pic_nop: "Herman",
      resolve_target_22h_text: "Minggu / 16 Agu 2026, 02:25:29 PM",
      notes: "Keluhan pelanggan di Danau Paris",
      analysis_text: "Kapasitas jaringan",
    };

    await markTicketAsSent(initialTicket, {
      targetJid: "120363000000000001@g.us",
    });

    // 2. Today: Same ticket is re-assigned to SQA
    const newExcelTicket = {
      order_id: "CC-20260815-00000323",
      assignment_type: "SQA",
      assignment_group: "Service Quality Assurance Sumbagut",
      cluster_area: "SQA",
      business_status: "InProgress",
      sla_status: "OUT SLA",
      reopen_number: "-",
      ccm_handling: "Ferry",
      pic_sqa: "Herman",
      resolve_target_22h_text: "Minggu / 16 Agu 2026, 02:25:29 PM",
      notes: "Keluhan pelanggan di Danau Paris",
      analysis_text: "Kapasitas jaringan",
    };

    const plan = await createSentTicketPlan([newExcelTicket]);
    assert.equal(plan.sendable_tickets.length, 1);
    assert.equal(plan.escalated_tickets.length, 1);
    assert.equal(plan.sendable_tickets[0].escalated_from, "NOP ACEH");

    // 3. Format message payload: Must include "Ticket Escalated from NOP ACEH"
    const payload = formatEscalationMessagePayload(plan.sendable_tickets[0]);
    assert.match(payload.text, /Ticket Escalated from NOP ACEH/);
    assert.match(payload.text, /CC-20260815-00000323/);
    assert.match(payload.text, /Keluhan pelanggan di Danau Paris/);
    assert.match(payload.text, /Kapasitas jaringan/);
    assert.match(payload.text, /SLA DUE DATE 24H : \*Minggu \/ 16 Agu 2026, 02:25:29 PM\*/);
  } finally {
    delete process.env.SENT_TICKET_STORE_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Escalated Reassignment: Detects transfer from SQA to NOP", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "escalate-sqa-nop-"));
  const tmpStore = path.join(tmpDir, "sent_tickets.json");
  process.env.SENT_TICKET_STORE_PATH = tmpStore;

  try {
    const initialTicket = {
      order_id: "CC-20260815-00000999",
      assignment_type: "SQA",
      assignment_group: "Service Quality Assurance Sumbagut",
      business_status: "InProgress",
      sla_status: "IN SLA",
      reopen_number: "-",
      ccm_handling: "Ferry",
      pic_sqa: "Herman",
      resolve_target_22h_text: "Senin / 17 Agu 2026, 10:00:00 AM",
      notes: "Problem note",
      analysis_text: "Analysis note",
    };

    await markTicketAsSent(initialTicket, {
      targetJid: "120363000000000002@g.us",
    });

    const newExcelTicket = {
      order_id: "CC-20260815-00000999",
      assignment_type: "NOP",
      assignment_group: "Network Operations and Productivity Pematangsiantar",
      cluster_area: "NOP PEMATANG SIANTAR",
      business_status: "InProgress",
      sla_status: "IN SLA",
      reopen_number: "-",
      pic_nop: "Ivan",
      resolve_target_22h_text: "Senin / 17 Agu 2026, 10:00:00 AM",
      notes: "Problem note",
      analysis_text: "Analysis note",
    };

    const plan = await createSentTicketPlan([newExcelTicket]);
    assert.equal(plan.sendable_tickets.length, 1);
    assert.equal(plan.sendable_tickets[0].escalated_from, "SQA");

    const payload = formatEscalationMessagePayload(plan.sendable_tickets[0]);
    assert.match(payload.text, /Ticket Escalated from SQA/);
    assert.match(payload.text, /CC-20260815-00000999/);
  } finally {
    delete process.env.SENT_TICKET_STORE_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Escalated Reassignment: Does NOT treat legacy generic NOP record as cross-assignment when imported to NOP ACEH", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "escalate-legacy-nop-"));
  const tmpStore = path.join(tmpDir, "sent_tickets.json");
  process.env.SENT_TICKET_STORE_PATH = tmpStore;

  try {
    // Legacy record only had assignment_type: "NOP" (no effective_target)
    await fs.writeFile(
      tmpStore,
      JSON.stringify({
        version: 1,
        tickets: {
          "CC-20260814-00000410": {
            order_id: "CC-20260814-00000410",
            assignment_type: "NOP",
            business_status: "InProgress",
            sla_status: "IN SLA",
            reopen_count: 0,
            target_jid: "120363411415015747@g.us",
            source_jid: "telegram:5085979770",
            sent_at: "2026-08-18T04:13:52.732Z",
            sent_date: "2026-08-18",
          },
        },
      }),
      "utf8",
    );

    const newExcelTicket = {
      order_id: "CC-20260814-00000410",
      assignment_type: "NOP",
      assignment_group: "Network Operations and Productivity Banda Aceh",
      cluster_area: "NOP ACEH",
      business_status: "InProgress",
      sla_status: "IN SLA",
      reopen_number: "-",
      pic_nop: "Irwan Saleh",
      resolve_target_22h_text: "Sabtu / 15 Agu 2026, 04:47:00 PM",
      notes: "Problem note",
      analysis_text: "Analysis note",
    };

    const plan = await createSentTicketPlan([newExcelTicket], new Date("2026-08-18T10:00:00Z"));
    // Since it was sent today and didn't change assignment, it should be a duplicate today!
    assert.equal(plan.sendable_tickets.length, 0);
    assert.equal(plan.duplicate_tickets.length, 1);
    assert.equal(plan.escalated_tickets.length, 0);
  } finally {
    delete process.env.SENT_TICKET_STORE_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

