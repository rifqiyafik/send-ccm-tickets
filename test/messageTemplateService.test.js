import test from "node:test";
import assert from "node:assert/strict";

import {
  deduplicateTicketsByOrderId,
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

  const outSlaTicket = {
    order_id: "CC-OUTSLA-1",
    assignment_type: "NOP",
    business_status: "In Progress",
    sla_status: "OUT SLA",
    analysis_text: "Root cause found",
    notes: "Follow up required",
    resolve_target_22h_text: "28/Agu/2026 18:00",
    pic_nop: "Ivan Setiawan Situmorang",
  };
  const outSlaPayload = formatEscalationMessagePayload(outSlaTicket);
  assert.ok(outSlaPayload.text.includes("Follow up required"));
  assert.ok(outSlaPayload.text.includes("Root cause found"));
  assert.ok(outSlaPayload.text.includes("SLA DUE DATE 24H : *28/Agu/2026 18:00*"));
});

test("deduplicateTicketsByOrderId removes duplicate tickets by order_id case-insensitively", () => {
  const tickets = [
    { order_id: "CC-20261102-00000306", site_id: "GST042" },
    { order_id: "cc-20261102-00000306", site_id: "GST042" },
    { order_id: "CC-20261104-00000422", site_id: "BPD050" },
    { order_id: "  CC-20261102-00000306  ", site_id: "GST042" },
  ];
  const deduped = deduplicateTicketsByOrderId(tickets);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].order_id, "CC-20261102-00000306");
  assert.equal(deduped[1].order_id, "CC-20261104-00000422");
});

test("formatSqaReminderMessage deduplicates duplicate tickets and excludes Site Visit", () => {
  const rawTickets = [
    {
      order_id: "CC-20261102-00000306",
      sla_status: "OUT SLA",
      departement_ns: "NOP PADANG SIDEMPUAN",
      site_id: "GST042",
      reopen_count: 5,
      problem_analysis: "Performance KPI di beberapa hari terlihat ada issue",
      assignment_type: "SQA",
    },
    // Duplicate of original SQA ticket
    {
      order_id: "CC-20261102-00000306",
      sla_status: "OUT SLA",
      departement_ns: "NOP PADANG SIDEMPUAN",
      site_id: "GST042",
      reopen_count: 5,
      problem_analysis: "Performance KPI di beberapa hari terlihat ada issue",
      assignment_type: "SQA",
    },
    // Site Visit clone / ticket
    {
      order_id: "CC-20261102-00000306",
      sla_status: "OUT SLA",
      departement_ns: "NOP PADANG SIDEMPUAN",
      site_id: "GST042",
      reopen_count: 5,
      problem_analysis: "Performance KPI di beberapa hari terlihat ada issue",
      assignment_type: "SQA",
      targetGroupKey: "SITE VISIT",
      is_site_visit: true,
    },
    // Another unique ticket
    {
      order_id: "CC-20261104-00000422",
      sla_status: "OUT SLA",
      departement_ns: "NOP ACEH",
      site_id: "BPD050",
      reopen_count: 3,
      problem_analysis: "Capacity dan Transport masih aman.",
      assignment_type: "SQA",
    },
    // Duplicate of second ticket with is_site_visit
    {
      order_id: "CC-20261104-00000422",
      sla_status: "OUT SLA",
      departement_ns: "NOP ACEH",
      site_id: "BPD050",
      reopen_count: 3,
      problem_analysis: "Capacity dan Transport masih aman.",
      assignment_type: "SQA",
      is_site_visit: true,
      targetGroupKey: "SITE VISIT",
    },
  ];

  const msg = formatSqaReminderMessage(rawTickets);

  // SLA Summary table should only count 2 unique tickets
  assert.ok(msg.includes("*SQA | 2 | 0 | 2*"), `Expected total 2, but msg was: ${msg}`);

  // Count occurrences of CC-20261102-00000306 in detail table
  const match1 = msg.match(/CC-20261102-00000306/g);
  assert.equal(match1 ? match1.length : 0, 1, "CC-20261102-00000306 should appear exactly once in details");

  // Count occurrences of CC-20261104-00000422 in detail table
  const match2 = msg.match(/CC-20261104-00000422/g);
  assert.equal(match2 ? match2.length : 0, 1, "CC-20261104-00000422 should appear exactly once in details");
});
