import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createSentTicketPlan,
  markTicketAsSent,
  formatSentTicketPlanReport,
} from "../src/services/sentTicketService.js";

test(".special Mode: Bypasses duplicate checks and forces resend of all valid tickets", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "special-mode-test-"));
  const tmpStore = path.join(tmpDir, "sent_tickets.json");
  process.env.SENT_TICKET_STORE_PATH = tmpStore;

  try {
    const today = new Date();
    // 1. Initial state: Ticket was already sent today
    const ticket1 = {
      order_id: "CC-20260818-00000111",
      assignment_type: "NOP",
      assignment_group: "Network Operations and Productivity Banda Aceh",
      cluster_area: "NOP ACEH",
      business_status: "InProgress",
      sla_status: "IN SLA",
      reopen_number: "-",
      pic_nop: "Irwan Saleh",
      resolve_target_22h_text: "Rabu / 19 Agu 2026, 10:00:00 AM",
      notes: "Keluhan pelanggan",
      analysis_text: "Investigasi radio",
    };

    await markTicketAsSent(ticket1, {
      targetJid: "120363000000000001@g.us",
    });

    // 2. Normal plan: Should categorize ticket1 as duplicate_tickets
    const normalPlan = await createSentTicketPlan([ticket1], today, {
      specialMode: false,
    });
    assert.equal(normalPlan.sendable_tickets.length, 0);
    assert.equal(normalPlan.duplicate_tickets.length, 1);

    // 3. Special plan (.special mode): Should put ticket1 into sendable_tickets
    const specialPlan = await createSentTicketPlan([ticket1], today, {
      specialMode: true,
    });
    assert.equal(specialPlan.sendable_tickets.length, 1);
    assert.equal(specialPlan.duplicate_tickets.length, 0);
    assert.equal(specialPlan.special_mode, true);

    // 4. Report format check
    const reportText = formatSentTicketPlanReport(specialPlan);
    assert.match(reportText, /Mode: Force Resend \(\.special\)/);
    assert.match(reportText, /Tiket Force Resend: 1/);

    // 5. Marking as sent in special mode updates sent_tickets.json
    await markTicketAsSent(specialPlan.sendable_tickets[0], {
      targetJid: "120363000000000001@g.us",
    });

    const savedData = JSON.parse(await fs.readFile(tmpStore, "utf8"));
    assert.ok(savedData.tickets["CC-20260818-00000111"]);
    assert.equal(
      savedData.tickets["CC-20260818-00000111"].effective_target,
      "NOP ACEH",
    );
  } finally {
    delete process.env.SENT_TICKET_STORE_PATH;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
