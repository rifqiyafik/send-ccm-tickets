import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSqaReminderMessage,
  formatNopReminderMessage,
  formatReopenEscalationText,
  formatOutSlaInProgressEscalationText,
  formatEscalationMessagePayload,
  formatTargetGroupOpeningMessage,
  formatUpdateTicketFileName,
  summarizeSla,
} from "../src/services/messageTemplateService.js";

test("messageTemplateService formats opening message and file name", () => {
  const opening = formatTargetGroupOpeningMessage();
  assert.ok(opening.includes("Assalamualaikum"));

  const fileName = formatUpdateTicketFileName(new Date(2026, 7, 28, 9, 0, 0));
  assert.ok(fileName.includes("Update Ticket 28 Agustus Pagi.xlsx"));
});

test("messageTemplateService summarizes SLA counts accurately", () => {
  const tickets = [
    { sla_status: "IN SLA" },
    { sla_status: "IN SLA" },
    { sla_status: "OUT SLA" },
  ];
  const summary = summarizeSla(tickets);
  assert.equal(summary.total, 3);
  assert.equal(summary.inSla, 2);
  assert.equal(summary.outSla, 1);
});

test("messageTemplateService formats SQA and NOP reminder tables", () => {
  const sqaTickets = [
    {
      order_id: "CC-SQA-01",
      sla_status: "IN SLA",
      departement_ns: "NOP PEMATANG SIANTAR",
      site_id: "PMS001",
      reopen_count: 2,
      problem_analysis: "Root cause detail",
    },
  ];
  const sqaMsg = formatSqaReminderMessage(sqaTickets);
  assert.ok(sqaMsg.includes("Remind Ticket CX Open:"));
  assert.ok(sqaMsg.includes("CC-SQA-01"));
  assert.ok(sqaMsg.includes("PMS"));

  const nopTickets = [
    {
      order_id: "CC-NOP-01",
      sla_status: "OUT SLA",
      departement_ns: "NOP PEMATANG SIANTAR",
      pic_nop: "Royza Iqbal Zaini",
      site_id: "PMS002",
      reopen_count: 1,
      problem_analysis: "Fiber cut repaired",
    },
  ];
  const nopMsg = formatNopReminderMessage(nopTickets);
  assert.ok(nopMsg.text.includes("Remind ticket CX Open :"));
  assert.ok(nopMsg.text.includes("CC-NOP-01"));
});

test("messageTemplateService formats ReOpen and Out SLA escalation messages", () => {
  const reopenTicket = {
    order_id: "CC-REOPEN-1",
    assignment_type: "NOP",
    use_reopen_message_format: true,
    reopen_count: 3,
    problem_analysis: "Splicing needed",
    resolve_target_22h_text: "28/Agu/2026 18:00",
    pic_nop: "Ivan Setiawan Situmorang",
  };
  const payload = formatEscalationMessagePayload(reopenTicket);
  assert.ok(payload.text.includes("Ticket Re-Open (3X)"));
  assert.ok(payload.text.includes("Splicing needed"));
});
