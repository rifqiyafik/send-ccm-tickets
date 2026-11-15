import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isTicketActive,
  extractTicketSiteId,
  extractComplaintDetail,
  formatTicketTimestamp,
  detectSiteRepetitiveTickets,
  formatSiteRepetitiveAlertMessage,
  generateSiteRepetitiveAlert,
} from "../src/services/siteRepetitiveService.js";

describe("siteRepetitiveService", () => {
  describe("isTicketActive", () => {
    it("considers null, undefined, empty, or running as active", () => {
      assert.equal(isTicketActive(null), true);
      assert.equal(isTicketActive(undefined), true);
      assert.equal(isTicketActive(""), true);
      assert.equal(isTicketActive("-"), true);
      assert.equal(isTicketActive("running"), true);
      assert.equal(isTicketActive("RUNNING"), true);
      assert.equal(isTicketActive("cancel"), true);
    });

    it("rejects completed status (case-insensitive)", () => {
      assert.equal(isTicketActive("completed"), false);
      assert.equal(isTicketActive("Completed"), false);
      assert.equal(isTicketActive(" COMPLETED "), false);
    });
  });

  describe("extractTicketSiteId", () => {
    it("extracts direct site_id cleanly", () => {
      assert.equal(extractTicketSiteId({ site_id: "MAK002" }), "MAK002");
      assert.equal(
        extractTicketSiteId({ site_id1_l1_assign: "BJI001" }),
        "BJI001",
      );
      assert.equal(
        extractTicketSiteId({ row_raw: { "site_id1(L1 Assign)": "MDN050" } }),
        "MDN050",
      );
    });

    it("falls back to Problem Analysis NSH site cover if direct site is empty or opaque", () => {
      const ticket = {
        site_id: "100000000001", // opaque
        row_raw: {
          problem_analysis_nsh:
            "Analisa tiket menunjukkan gangguan di #Site Cover: BJI179",
        },
      };
      const siteId = extractTicketSiteId(ticket);
      assert.equal(siteId, "BJI179");
    });

    it("returns null if no valid site id can be resolved", () => {
      assert.equal(extractTicketSiteId(null), null);
      assert.equal(extractTicketSiteId({ site_id: "-" }), null);
      assert.equal(extractTicketSiteId({ site_id: "NULL" }), null);
    });
  });

  describe("extractComplaintDetail", () => {
    it("extracts from fault symptoms column cleanly", () => {
      const ticket = {
        description_fault_sumptomps_create_ticket_description_fault_sym:
          "Sinyal drop di area pertokoan jalan sudirman",
      };
      assert.equal(
        extractComplaintDetail(ticket),
        "Sinyal drop di area pertokoan jalan sudirman",
      );
    });

    it("falls back to raw_description or description", () => {
      const ticket = {
        raw_description: "Pelanggan komplain tidak bisa internet",
      };
      assert.equal(
        extractComplaintDetail(ticket),
        "Pelanggan komplain tidak bisa internet",
      );
    });

    it("truncates long complaint text gracefully", () => {
      const longText = "A".repeat(200);
      const res = extractComplaintDetail({ raw_description: longText }, 50);
      assert.equal(res.length, 50);
      assert.ok(res.endsWith("..."));
    });
  });

  describe("formatTicketTimestamp", () => {
    it("formats standard date and time in WIB", () => {
      const ticket = {
        create_time: "2026-11-12 14:30:00",
      };
      const formatted = formatTicketTimestamp(ticket);
      assert.ok(formatted.includes("12 Nov 2026"));
      assert.ok(formatted.includes("14:30 WIB"));
    });

    it("handles date only without showing 00:00 WIB", () => {
      const ticket = {
        date: "2026-11-10",
      };
      const formatted = formatTicketTimestamp(ticket);
      assert.equal(formatted, "10 Nov 2026");
    });
  });

  describe("detectSiteRepetitiveTickets", () => {
    const referenceDate = new Date("2026-11-13T10:00:00Z");

    it("detects site with >= 2 active tickets in batch within 7 days", async () => {
      const batchTickets = [
        {
          order_id: "ORD-001",
          site_id: "MAK002",
          order_status: "running",
          create_time: "2026-11-12 09:00:00",
          city: "KOTA MEDAN",
          departement_ns: "NOP MEDAN",
          complaint_detail: "Sinyal putus-putus",
        },
        {
          order_id: "ORD-002",
          site_id: "MAK002",
          order_status: null, // null considered active
          create_time: "2026-11-13 08:30:00",
          city: "KOTA MEDAN",
          departement_ns: "NOP MEDAN",
          complaint_detail: "No 4G coverage",
        },
        {
          order_id: "ORD-003",
          site_id: "BJI001", // only 1 ticket for BJI001
          order_status: "running",
          create_time: "2026-11-13 07:00:00",
          city: "KOTA BINJAI",
          departement_ns: "NOP BINJAI",
          complaint_detail: "Lemot",
        },
      ];

      const detected = await detectSiteRepetitiveTickets(batchTickets, {
        referenceDate,
        skipDb: true,
      });

      assert.equal(detected.length, 1);
      assert.equal(detected[0].site_id, "MAK002");
      assert.equal(detected[0].count, 2);
      assert.equal(detected[0].city, "NAGAN RAYA");
      assert.equal(detected[0].site_name, "DESARANTAUSELAMAT");
      assert.equal(detected[0].nop, "NOP ACEH");
      assert.equal(detected[0].tickets.length, 2);
      assert.equal(detected[0].tickets[0].order_id, "ORD-002"); // newest first
    });

    it("ignores completed tickets from counting towards threshold", async () => {
      const batchTickets = [
        {
          order_id: "ORD-101",
          site_id: "MAK002",
          order_status: "completed", // completed, should be ignored
          create_time: "2026-11-12 09:00:00",
          complaint_detail: "Sudah selesai",
        },
        {
          order_id: "ORD-102",
          site_id: "MAK002",
          order_status: "running", // only 1 active ticket
          create_time: "2026-11-13 08:30:00",
          complaint_detail: "Keluhan baru",
        },
      ];

      const detected = await detectSiteRepetitiveTickets(batchTickets, {
        referenceDate,
        skipDb: true,
      });

      assert.equal(detected.length, 0); // threshold 2 not reached
    });

    it("ignores tickets older than 7 days lookback window", async () => {
      const batchTickets = [
        {
          order_id: "ORD-201",
          site_id: "MAK002",
          order_status: "running",
          create_time: "2026-10-01 09:00:00", // > 1 month old
          complaint_detail: "Keluhan lama",
        },
        {
          order_id: "ORD-202",
          site_id: "MAK002",
          order_status: "running",
          create_time: "2026-11-13 08:30:00",
          complaint_detail: "Keluhan baru",
        },
      ];

      const detected = await detectSiteRepetitiveTickets(batchTickets, {
        referenceDate,
        skipDb: true,
      });

      assert.equal(detected.length, 0);
    });

    it("merges 1 ticket from DB with 1 ticket from batch to trigger repetitive threshold", async () => {
      process.env.PG_HOST = "localhost";
      process.env.PG_DATABASE = "postgres";
      process.env.PG_USER = "postgres";

      const mockPool = {
        query: async (sql, params) => {
          assert.ok(
            sql.includes(
              'FROM "SQA_SUMBAGUT"."inap_ticketing_customer_complain"',
            ),
          );
          assert.deepEqual(params[0], ["MAK002"]);
          return {
            rows: [
              {
                order_id: "ORD-PREV-DB",
                ticket_id: "INC-PREV-DB",
                date: "2026-11-10",
                create_time: "2026-11-10 11:00:00",
                site_id: "MAK002",
                city: "NAGAN RAYA",
                order_status: "running",
                sla_status: "Within SLA",
                complaint_detail: "Komplain sebelumnya dari DB",
              },
            ],
          };
        },
      };

      const batchTickets = [
        {
          order_id: "ORD-TODAY-BATCH",
          site_id: "MAK002",
          order_status: "running",
          create_time: "2026-11-13 08:30:00",
          complaint_detail: "Komplain hari ini",
        },
      ];

      const detected = await detectSiteRepetitiveTickets(batchTickets, {
        referenceDate,
        customPool: mockPool,
      });

      delete process.env.PG_HOST;
      delete process.env.PG_DATABASE;
      delete process.env.PG_USER;

      assert.equal(detected.length, 1);
      assert.equal(detected[0].site_id, "MAK002");
      assert.equal(detected[0].count, 2);
      assert.equal(detected[0].tickets.length, 2);
      assert.equal(detected[0].tickets[0].order_id, "ORD-TODAY-BATCH");
      assert.equal(detected[0].tickets[1].order_id, "ORD-PREV-DB");
    });
  });

  describe("formatSiteRepetitiveAlertMessage", () => {
    it("formats readable alert message with header, site metadata and ticket details", () => {
      const groups = [
        {
          site_id: "MAK002",
          site_name: "MEDAN KOTA",
          city: "KOTA MEDAN",
          nop: "NOP MEDAN",
          count: 2,
          tickets: [
            {
              order_id: "1-10023456",
              timestamp_text: "12 Nov 2026 14:20 WIB",
              order_status: "running",
              sla_status: "Within SLA",
              complaint_detail: "Sinyal drop di sekitar kantor kecamatan",
            },
            {
              order_id: "1-10023489",
              timestamp_text: "13 Nov 2026 09:15 WIB",
              order_status: "running",
              sla_status: "Out of SLA",
              complaint_detail: "Pelanggan komplain no service",
            },
          ],
        },
      ];

      const text = formatSiteRepetitiveAlertMessage(groups);
      assert.ok(text.includes("KOMPLAIN REPETITIF SITE ID (7 HARI TERAKHIR)"));
      assert.ok(text.includes("Terdeteksi *1 site* dengan komplain berulang"));
      assert.ok(text.includes("📍 *Site ID: MAK002* (KOTA MEDAN - NOP MEDAN)"));
      assert.ok(text.includes("• *Nama Site*: MEDAN KOTA"));
      assert.ok(text.includes("• *Total Tiket Aktif*: *2 tiket*"));
      assert.ok(text.includes("1. *1-10023456* (12 Nov 2026 14:20 WIB)"));
      assert.ok(text.includes("Status: `running`"));
      assert.ok(
        text.includes("Keluhan*: Sinyal drop di sekitar kantor kecamatan"),
      );
      assert.ok(text.includes("2. *1-10023489* (13 Nov 2026 09:15 WIB)"));
      assert.ok(
        text.includes(
          "Pesan ini hanya dikirimkan ke grup pengirim sebagai monitoring komplain repetitif",
        ),
      );
    });

    it("returns null when repetitive groups is empty", () => {
      assert.equal(formatSiteRepetitiveAlertMessage([]), null);
      assert.equal(formatSiteRepetitiveAlertMessage(null), null);
    });
  });

  describe("generateSiteRepetitiveAlert", () => {
    it("returns complete payload when repetitive tickets are found", async () => {
      const tickets = [
        {
          order_id: "ORD-A",
          site_id: "BJI001",
          order_status: "running",
          create_time: "2026-11-13 10:00:00",
          complaint_detail: "Komplain 1",
        },
        {
          order_id: "ORD-B",
          site_id: "BJI001",
          order_status: "running",
          create_time: "2026-11-13 10:10:00",
          complaint_detail: "Komplain 2",
        },
      ];

      const alert = await generateSiteRepetitiveAlert(tickets, {
        referenceDate: new Date("2026-11-13T12:00:00Z"),
        skipDb: true,
      });

      assert.ok(alert);
      assert.equal(alert.siteCount, 1);
      assert.equal(alert.totalTickets, 2);
      assert.ok(alert.text.includes("BJI001"));
    });

    it("returns null when tickets do not trigger repetitive alert", async () => {
      const tickets = [
        {
          order_id: "ORD-SINGLE",
          site_id: "BJI001",
          order_status: "running",
          create_time: "2026-11-13 10:00:00",
        },
      ];

      const alert = await generateSiteRepetitiveAlert(tickets, {
        referenceDate: new Date("2026-11-13T12:00:00Z"),
        skipDb: true,
      });

      assert.equal(alert, null);
    });
  });
});
