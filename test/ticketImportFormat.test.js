import assert from "node:assert/strict";
import test from "node:test";

import {
  formatImportSummary,
  formatProcessingReport,
} from "../src/services/ticketImportService.js";
import { formatTelegramRichText } from "../src/utils/telegramFormat.js";

function extractCodeBlocks(value) {
  return [...value.matchAll(/```([\s\S]*?)```/g)].map((match) =>
    match[1].trim().split("\n"),
  );
}

function assertAlignedCodeTable(lines) {
  const width = lines[0].length;
  for (const line of lines) {
    assert.equal(line.length, width, line);
  }
}

test("formats import summary with literal emoji", () => {
  const summary = formatImportSummary({
    ok: true,
    total_rows: 3,
    valid_count: 2,
    skipped_count: 1,
  });

  assert.match(summary, /✅ Import tiket selesai/);
  assert.match(summary, /📊 Total row: 3/);
});

test("formats processing report tables as fenced code blocks", () => {
  const report = formatProcessingReport({
    ok: true,
    valid_by_assignment_type: { SQA: 1 },
    valid_by_pic: { Herman: 1 },
    skipped_by_reason: { CITY_NOT_FOUND: 1 },
    skipped_tickets: [
      {
        order_id: "CC-1",
        reason: "CITY_NOT_FOUND",
        city: "KOTA TEST",
        assignment_group: "SQA",
        site_id: "MDN001",
      },
    ],
    valid_tickets: [
      {
        order_id: "CC-2",
        assignment_type: "SQA",
        city: "KOTA MEDAN",
        sla_status: "IN SLA",
        pic: "Herman",
        site_id: "MDN002",
      },
    ],
  });

  assert.match(report, /📋 Detail tiket yang dilewati:/);
  assert.match(report, /🗂️ Valid per Assignment:\n```\n\+-----------------\+-------\+/);
  assert.match(report, /👤 Valid per PIC:\n```\n\+--------------\+-------\+/);
  assert.match(report, /```\n\+-+\+/);
  assert.equal(formatTelegramRichText(report).match(/<pre>/g).length, 4);
});

test("formats processing report tables with aligned static borders", () => {
  const report = formatProcessingReport({
    ok: true,
    valid_by_assignment_type: { SQA: 19, NOP: 2 },
    valid_by_pic: {
      Herman: 2,
      Ahsan: 6,
      "Dean RM Simamora": 1,
      "Fernando Pasaribu": 9,
      "Ivan Setiawan Situmorang": 1,
    },
    skipped_by_reason: { ASSIGNMENT_GROUP_NOT_SUPPORTED: 6 },
    skipped_tickets: [
      {
        order_id: "CC-20260513-00000106",
        reason: "ASSIGNMENT_GROUP_NOT_SUPPORTED",
        city: "KOTA BANDA ACEH",
        assignment_group: "RTP ENGINEERING SUMBAGUT",
        site_id: "-",
      },
    ],
    valid_tickets: [
      {
        order_id: "CC-20260718-00000161",
        assignment_type: "SQA",
        city: "KOTA MEDAN",
        sla_status: "IN SLA",
        pic: "Fernando Pasaribu",
        site_id: "LBP284",
      },
    ],
  });

  for (const table of extractCodeBlocks(report)) {
    assertAlignedCodeTable(table);
  }
});
