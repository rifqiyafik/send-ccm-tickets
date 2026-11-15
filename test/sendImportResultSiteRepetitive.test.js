import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sendImportResult } from "../src/handlers/whatsappMessageHandler.js";

describe("sendImportResult - Site Repetitive Complaints Alert", () => {
  it("sends site repetitive alert exclusively to sourceJid when threshold is met", async () => {
    const sentMessages = [];
    const sourceJid = "120363000000000001@g.us";

    const mockSock = {
      sendMessage: async (jid, content) => {
        sentMessages.push({ jid, content });
        return { key: { id: "mock-id" } };
      },
    };

    const validTickets = [
      {
        order_id: "ORD-REP-1",
        ticket_id: "TKT-REP-1",
        site_id: "MAK002",
        order_status: "running",
        create_time: "2026-11-12 10:00:00",
        city: "NAGAN RAYA",
        departement_ns: "NOP ACEH",
        assignment_type: "NOP",
        complaint_detail: "Sinyal putus-putus",
      },
      {
        order_id: "ORD-REP-2",
        ticket_id: "TKT-REP-2",
        site_id: "MAK002",
        order_status: "running",
        create_time: "2026-11-13 09:00:00",
        city: "NAGAN RAYA",
        departement_ns: "NOP ACEH",
        assignment_type: "NOP",
        complaint_detail: "No 4G data coverage",
      },
    ];

    const result = {
      ok: true,
      total_rows: 2,
      valid_count: 2,
      skipped_count: 0,
      valid_tickets: validTickets,
      skipped_tickets: [],
      grouped_tickets: {},
      processing_log: [],
      skipped_by_reason: {},
      valid_by_pic: { "Budi": 2 },
      valid_by_assignment_type: { NOP: 2 },
    };

    await sendImportResult(mockSock, sourceJid, result, {
      summaryOnlyMode: true,
      skipDb: true,
      referenceDate: new Date("2026-11-13T12:00:00Z"),
    });

    // Cari pesan alert komplain repetitif
    const alertMsg = sentMessages.find(
      (m) =>
        m.content?.text &&
        m.content.text.includes("KOMPLAIN REPETITIF SITE ID"),
    );

    assert.ok(alertMsg, "Pesan komplain repetitif harus terkirim");
    assert.equal(alertMsg.jid, sourceJid, "Alert HANYA boleh dikirim ke sourceJid");
    assert.ok(alertMsg.content.text.includes("MAK002"));
    assert.ok(alertMsg.content.text.includes("ORD-REP-1"));
    assert.ok(alertMsg.content.text.includes("ORD-REP-2"));
    assert.ok(alertMsg.content.text.includes("Sinyal putus-putus"));
    assert.ok(alertMsg.content.text.includes("No 4G data coverage"));

    // Pastikan tidak ada pengiriman alert ini ke jid lain
    const alertsToOtherJids = sentMessages.filter(
      (m) =>
        m.jid !== sourceJid &&
        m.content?.text &&
        m.content.text.includes("KOMPLAIN REPETITIF SITE ID"),
    );
    assert.equal(alertsToOtherJids.length, 0, "Alert TIDAK boleh dikirim ke grup lain");
  });

  it("does not send alert when order_status is completed", async () => {
    const sentMessages = [];
    const sourceJid = "120363000000000001@g.us";

    const mockSock = {
      sendMessage: async (jid, content) => {
        sentMessages.push({ jid, content });
        return { key: { id: "mock-id" } };
      },
    };

    const validTickets = [
      {
        order_id: "ORD-COMP-1",
        site_id: "MAK002",
        order_status: "completed",
        create_time: "2026-11-12 10:00:00",
        assignment_type: "NOP",
      },
      {
        order_id: "ORD-COMP-2",
        site_id: "MAK002",
        order_status: "running",
        create_time: "2026-11-13 09:00:00",
        assignment_type: "NOP",
      },
    ];

    const result = {
      ok: true,
      total_rows: 2,
      valid_count: 2,
      skipped_count: 0,
      valid_tickets: validTickets,
      skipped_tickets: [],
      grouped_tickets: {},
      processing_log: [],
      skipped_by_reason: {},
      valid_by_pic: { "Budi": 2 },
      valid_by_assignment_type: { NOP: 2 },
    };

    await sendImportResult(mockSock, sourceJid, result, {
      summaryOnlyMode: true,
      skipDb: true,
      referenceDate: new Date("2026-11-13T12:00:00Z"),
    });

    const alertMsg = sentMessages.find(
      (m) =>
        m.content?.text &&
        m.content.text.includes("KOMPLAIN REPETITIF SITE ID"),
    );

    assert.equal(
      alertMsg,
      undefined,
      "Alert tidak boleh dikirim jika tiket aktif < 2",
    );
  });
});
