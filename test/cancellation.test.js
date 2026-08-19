import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelActiveDelivery,
  isDeliveryCancelled,
  sendImportResult,
} from "../src/handlers/whatsappMessageHandler.js";

test("cancelActiveDelivery persists cancellation flag and prevents reminder dispatch", async () => {
  cancelActiveDelivery("User cancel test");
  assert.equal(isDeliveryCancelled(), true);

  const sentMessages = [];
  const mockSock = {
    sendMessage: async (jid, payload) => {
      sentMessages.push({ jid, payload });
      return { key: { id: "mock-msg-id" } };
    },
  };

  // When a new import starts, activeDeliveryCancelled is reset at the beginning
  // But if cancelled during run, it stops further execution
  const mockResult = {
    ok: true,
    total_rows: 1,
    valid_count: 1,
    skipped_count: 0,
    valid_tickets: [
      {
        order_id: "CC-20260819-00000001",
        ticket_id: "INC12345",
        assignment_type: "SQA",
        assignment_group: "Service Quality Assurance Sumbagut",
        cluster_area: "SQA",
        business_status: "InProgress",
        sla_status: "IN SLA",
        pic_sqa: "Herman",
        notes: "Test note",
        analysis_text: "Test analysis",
      },
    ],
  };

  // Simulate cancellation before reminder
  cancelActiveDelivery("User cancel test");
  await sendImportResult(mockSock, "120363000000000001@g.us", mockResult, {
    reminderMode: true,
  });

  // Only the initial summary might be sent, but NO reminder completion or dispatch should happen
  const reminderSuccessMessages = sentMessages.filter((m) =>
    String(m.payload?.text || "").includes("Reminder Berhasil Dikirim"),
  );
  assert.equal(reminderSuccessMessages.length, 0);
});
