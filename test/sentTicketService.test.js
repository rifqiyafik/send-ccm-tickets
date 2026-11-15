import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createSentTicketPlan,
  formatSentTicketPlanReport,
  formatSqaAreaFollowUpMessage,
  formatNopAreaSummaryMessage,
  markTicketAsSent,
} from "../src/services/sentTicketService.js";

function setupStore(name, initialStore = null) {
  const storePath = path.join("tmp", `${name}-sent-tickets.json`);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.rmSync(storePath, { force: true });

  if (initialStore) {
    fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2));
  }

  process.env.SENT_TICKET_STORE_PATH = storePath;
  process.env.SENT_TICKET_RETENTION_DAYS = "7";

  return {
    storePath,
    cleanup() {
      fs.rmSync(storePath, { force: true });
      delete process.env.SENT_TICKET_STORE_PATH;
      delete process.env.SENT_TICKET_RETENTION_DAYS;
    },
  };
}

function ticket(overrides = {}) {
  return {
    order_id: "CC-1",
    assignment_type: "SQA",
    business_status: "In Progress",
    sla_status: "IN SLA",
    resolve_target_22h_text: "Rabu / 22 Jul 2026, 11:50:38 PM",
    ccm_handling: "Budi",
    pic_sqa: "Ahsan",
    notes: "Keluhan pelanggan",
    analysis_text: "Analisis tiket",
    ...overrides,
  };
}

test("allows new IN SLA ticket and stores it after successful send", async () => {
  const context = setupStore("new-ticket");

  const plan = await createSentTicketPlan([ticket()]);
  assert.equal(plan.sendable_tickets.length, 1);
  assert.equal(plan.duplicate_tickets.length, 0);
  assert.equal(plan.out_sla_tickets.length, 0);

  await markTicketAsSent(ticket(), {
    sourceJid: "source@g.us",
    targetJid: "target@g.us",
  });

  const store = JSON.parse(fs.readFileSync(context.storePath, "utf8"));
  assert.equal(store.tickets["CC-1"].business_status, "In Progress");
  assert.equal(store.tickets["CC-1"].target_jid, "target@g.us");

  context.cleanup();
});

test("skips duplicate IN SLA ticket when business status is not ReOpen transition", async () => {
  const context = setupStore("duplicate-ticket", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        business_status: "In Progress",
        sla_status: "IN SLA",
        sent_at: "2026-07-21T00:00:00.000Z",
        sent_date: "2026-07-21",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [ticket({ business_status: "In Progress" })],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.duplicate_tickets.length, 1);
  assert.match(
    formatSentTicketPlanReport(plan),
    /Tiket Sudah Pernah Dikirim Hari Ini: 1/,
  );
  assert.match(formatSentTicketPlanReport(plan), /```\n\+-+/);

  context.cleanup();
});

test("resends ticket when previous business status was IN PROGRESS and current status is ReOpen", async () => {
  const context = setupStore("reopen-transition", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        business_status: "IN PROGRESS",
        sla_status: "IN SLA",
        sent_at: "2026-07-21T00:00:00.000Z",
        sent_date: "2026-07-21",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [
      ticket({
        business_status: "ReOpen",
        use_reopen_message_format: true,
        reopen_number: "2",
      }),
    ],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 1);
  assert.equal(plan.reopened_tickets.length, 1);
  assert.equal(plan.duplicate_tickets.length, 0);

  context.cleanup();
});

test("resends ticket when business status is ReOpen and reopen_count increased today", async () => {
  const context = setupStore("reopen-count-increase", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        business_status: "REOPEN",
        sla_status: "IN SLA",
        reopen_count: 2,
        sent_at: "2026-07-21T00:00:00.000Z",
        sent_date: "2026-07-21",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [
      ticket({
        business_status: "ReOpen",
        use_reopen_message_format: true,
        reopen_number: "3",
      }),
    ],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 1);
  assert.equal(plan.reopened_tickets.length, 1);
  assert.equal(plan.duplicate_tickets.length, 0);

  context.cleanup();
});

test("plans previous-day OUT SLA In Progress ticket as daily reminder only", async () => {
  const context = setupStore("out-sla-ticket", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        business_status: "IN PROGRESS",
        sla_status: "IN SLA",
        sent_at: "2026-07-20T00:00:00.000Z",
        sent_date: "2026-07-20",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [ticket({ business_status: "In Progress", sla_status: "OUT SLA" })],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.in_progress_reminder_tickets.length, 1);
  assert.equal(plan.reopened_tickets.length, 0);
  assert.equal(plan.out_sla_tickets.length, 1);

  context.cleanup();
});

test("plans previous-day IN SLA In Progress ticket as daily reminder only", async () => {
  const context = setupStore("in-sla-daily-reminder-ticket", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        business_status: "IN PROGRESS",
        sla_status: "IN SLA",
        sent_at: "2026-07-20T00:00:00.000Z",
        sent_date: "2026-07-20",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [ticket({ business_status: "In Progress", sla_status: "IN SLA" })],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.in_progress_reminder_tickets.length, 1);
  assert.equal(plan.in_sla_reminder_tickets.length, 1);
  assert.equal(plan.out_sla_tickets.length, 0);

  context.cleanup();
});

test("skips ticket already sent today with same business status", async () => {
  const context = setupStore("duplicate-today-ticket", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        business_status: "IN PROGRESS",
        sla_status: "OUT SLA",
        sent_at: "2026-07-21T00:00:00.000Z",
        sent_date: "2026-07-21",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [ticket({ business_status: "In Progress", sla_status: "OUT SLA" })],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.duplicate_tickets.length, 1);
  assert.equal(plan.out_sla_tickets.length, 0);

  context.cleanup();
});

test("skips ticket when required message data is empty", async () => {
  const context = setupStore("invalid-message-ticket");

  const plan = await createSentTicketPlan([
    ticket({ notes: "", analysis_text: "" }),
  ]);

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.invalid_message_tickets.length, 1);
  assert.deepEqual(plan.invalid_message_tickets[0].missing_fields, [
    "notes",
    "analysis_text",
  ]);
  assert.match(
    formatSentTicketPlanReport(plan),
    /Data Tidak Lengkap Butuh Bantuan: 1/,
  );

  context.cleanup();
});

test("reports incomplete data that was resolved by fallback and still sent", async () => {
  const context = setupStore("fallback-resolved-ticket");

  const plan = await createSentTicketPlan([
    ticket({
      notes:
        "Problem Start Time : 2026-07-23 03:21:18\nComplaint Detail : Keluhan",
      analysis_text: "Problem Analysis NSH fallback",
      fallback_resolutions: [
        {
          field: "notes",
          source: "Problem Start Time, Customer Interaction Date, Customer MSISDN, Address, Description",
          missing_fields: [],
        },
        {
          field: "analysis_text",
          source: "Problem Analysis NSH",
          missing_fields: [],
        },
      ],
    }),
  ]);

  const report = formatSentTicketPlanReport(plan);

  assert.equal(plan.sendable_tickets.length, 1);
  assert.equal(plan.invalid_message_tickets.length, 0);
  assert.equal(plan.fallback_resolved_tickets.length, 1);
  assert.match(report, /Data Tidak Lengkap yang Dikirim: 1/);
  assert.match(report, /CC-1/);
  assert.match(report, /notes/);
  assert.match(report, /analysis_text/);

  context.cleanup();
});

test("cleans sent ticket records older than retention days", async () => {
  const context = setupStore("retention-cleanup", {
    version: 1,
    tickets: {
      OLD: {
        order_id: "OLD",
        business_status: "In Progress",
        sent_at: "2026-07-01T00:00:00.000Z",
      },
      RECENT: {
        order_id: "RECENT",
        business_status: "In Progress",
        sent_at: "2026-07-20T00:00:00.000Z",
      },
    },
  });

  await createSentTicketPlan([], new Date("2026-07-21T00:00:00.000Z"));

  const store = JSON.parse(fs.readFileSync(context.storePath, "utf8"));
  assert.equal(store.tickets.OLD, undefined);
  assert.equal(store.tickets.RECENT.order_id, "RECENT");

  context.cleanup();
});

test("formats SQA area follow-up message from sendable tickets", () => {
  const message = formatSqaAreaFollowUpMessage([
    ticket({ nsa: "ACEH", pic_sqa: "Herman" }),
    ticket({ nsa: "ACEH", pic_sqa: "Herman" }),
    ticket({ nsa: "MEDAN", pic_sqa: "Ahsan" }),
    ticket({ assignment_type: "NOP", nsa: "BINJAI", pic_nop: "Rizlul" }),
  ]);

  assert.match(message, /Assalamualaikum/);
  assert.match(message, /2 tiket SQA area Aceh \(Bg Herman\)/);
  assert.match(message, /1 tiket SQA area Medan \(Bg Ahsan\)/);
  assert.doesNotMatch(message, /BINJAI/);
});

test("formats SQA area follow-up message sorted by departemen ns", () => {
  const message = formatSqaAreaFollowUpMessage([
    ticket({
      city: "KOTA MEDAN",
      nsa: "MEDAN",
      cluster_area: "NOP MEDAN",
      pic_sqa: "Ahsan",
    }),
    ticket({
      city: "ACEH BARAT",
      nsa: "ACEH",
      cluster_area: "NOP ACEH",
      pic_sqa: "Herman",
    }),
    ticket({
      city: "DELI SERDANG",
      nsa: "MEDAN",
      cluster_area: "NOP MEDAN",
      pic_sqa: "Ahsan",
    }),
  ]);

  assert.match(message, /1 tiket SQA area Aceh \(Bg Herman\)/);
  assert.match(message, /2 tiket SQA area Medan \(Bg Ahsan\)/);
  assert.doesNotMatch(message, /Aceh Barat/);
  assert.doesNotMatch(message, /Deli Serdang/);
  assert.doesNotMatch(message, /Kota Medan/);
  assert.ok(message.indexOf("Aceh") < message.indexOf("Medan"));
});

test("formats SQA area follow-up message from departemen ns instead of city", () => {
  const message = formatSqaAreaFollowUpMessage([
    ticket({
      city: "ACEH BESAR",
      nsa: "ACEH",
      departemen_ns: "NOP ACEH",
      pic_sqa: "Herman",
    }),
    ticket({
      city: "ACEH JAYA",
      nsa: "ACEH",
      departemen_ns: "NOP ACEH",
      pic_sqa: "Herman",
    }),
    ticket({
      city: "GAYO LUES",
      nsa: "ACEH",
      departement_ns: "NOP ACEH",
      pic_sqa: "Herman",
    }),
    ticket({
      city: "KOTA MEDAN",
      nsa: "MEDAN",
      cluster_area: "NOP MEDAN",
      pic_sqa: "Ahsan",
    }),
    ticket({
      city: "DELI SERDANG",
      nsa: "MEDAN",
      cluster_area: "NOP MEDAN",
      pic_sqa: "Ahsan",
    }),
  ]);

  assert.match(message, /3 tiket SQA area Aceh \(Bg Herman\)/);
  assert.match(message, /2 tiket SQA area Medan \(Bg Ahsan\)/);
  assert.doesNotMatch(message, /Aceh Besar/);
  assert.doesNotMatch(message, /Aceh Jaya/);
  assert.doesNotMatch(message, /Gayo Lues/);
  assert.doesNotMatch(message, /Deli Serdang/);
});

test("formats SQA area follow-up message like the requested template", () => {
  const tickets = [
    ...Array.from({ length: 5 }, () => ticket({ nsa: "ACEH", pic_sqa: "Herman" })),
    ...Array.from({ length: 1 }, () => ticket({ nsa: "BINJAI", pic_sqa: "Herman" })),
    ...Array.from({ length: 4 }, () => ticket({ nsa: "MEDAN", pic_sqa: "Ahsan" })),
    ...Array.from({ length: 2 }, () =>
      ticket({ nsa: "PADANG SIDEMPUAN", pic_sqa: "Ahsan" }),
    ),
    ...Array.from({ length: 6 }, () =>
      ticket({ nsa: "PEMATANG SIANTAR", pic_sqa: "Fernando" }),
    ),
    ...Array.from({ length: 4 }, () =>
      ticket({ nsa: "RANTAU PRAPAT", pic_sqa: "Fernando" }),
    ),
  ];

  assert.equal(
    formatSqaAreaFollowUpMessage(tickets),
    [
      "Assalamualaikum,",
      "Semangat Pagi dan Semangat Sehat,",
      "Dear Bapak Manager dan SQA Team ,",
      "Berikut kami infokan tiket Remedy Customer Complaint yg masih open di SQA,",
      "",
      "Mohon dibantu untuk segera di follow up.",
      "5 tiket SQA area Aceh (Bg Herman)",
      "1 tiket SQA area Binjai (Bg Herman)",
      "4 tiket SQA area Medan (Bg Ahsan)",
      "2 tiket SQA area Padang Sidempuan (Bg Ahsan)",
      "6 tiket SQA area Pematang Siantar (Bg Fernando)",
      "4 tiket SQA area Rantau Prapat (Bg Fernando)",
      "",
      "Terimakasih sebelumnya 🙏🏻😇",
    ].join("\n"),
  );
});

test("ticketOnlyMode treats in-progress tickets from previous days as duplicate without reminding", async () => {
  const context = setupStore("ticket-only-mode", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        assignment_type: "SQA",
        business_status: "InProgress",
        sla_status: "OUT SLA",
        sent_at: "2026-08-30T08:00:00.000Z",
        sent_date: "2026-08-30",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [
      ticket({
        order_id: "CC-1",
        business_status: "InProgress",
        sla_status: "OUT SLA",
      }),
    ],
    new Date("2026-08-31T08:00:00.000Z"),
    { ticketOnlyMode: true },
  );

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.duplicate_tickets.length, 1);
  assert.equal(plan.out_sla_tickets.length, 0);
  assert.equal(plan.in_progress_reminder_tickets.length, 0);

  context.cleanup();
});

test("pollingMode skips already-sent tickets from previous days unless reopen or escalated", async () => {
  const context = setupStore("polling-mode-dedup", {
    version: 1,
    tickets: {
      "CC-YESTERDAY-1": {
        order_id: "CC-YESTERDAY-1",
        assignment_type: "SQA",
        assignment_group: "SQA",
        business_status: "L2 Assign",
        sla_status: "IN SLA",
        reopen_count: 0,
        sent_at: "2026-09-12T08:00:00.000Z",
        sent_date: "2026-09-12",
      },
      "CC-YESTERDAY-2": {
        order_id: "CC-YESTERDAY-2",
        assignment_type: "NOP",
        cluster_area: "NOP MEDAN",
        business_status: "L2 Assign",
        sla_status: "IN SLA",
        reopen_count: 0,
        sent_at: "2026-09-12T08:00:00.000Z",
        sent_date: "2026-09-12",
      },
    },
  });

  // 1. Same tickets polled today without status change -> 0 sendable, 2 duplicates
  const planUnchanged = await createSentTicketPlan(
    [
      ticket({
        order_id: "CC-YESTERDAY-1",
        business_status: "L2 Assign",
        assignment_type: "SQA",
        reopen_number: "0",
      }),
      ticket({
        order_id: "CC-YESTERDAY-2",
        business_status: "L2 Assign",
        assignment_type: "NOP",
        cluster_area: "NOP MEDAN",
        pic_nop: "Nasrul Amin",
        reopen_number: "0",
      }),
    ],
    new Date("2026-09-13T08:00:00.000Z"),
    { pollingMode: true, ticketOnlyMode: true },
  );

  assert.equal(planUnchanged.sendable_tickets.length, 0);
  assert.equal(planUnchanged.duplicate_tickets.length, 2);

  // 2. Ticket 1 reopened -> 1 sendable, 1 duplicate
  const planReopened = await createSentTicketPlan(
    [
      ticket({
        order_id: "CC-YESTERDAY-1",
        business_status: "Reopen",
        assignment_type: "SQA",
        reopen_number: "1",
      }),
      ticket({
        order_id: "CC-YESTERDAY-2",
        business_status: "L2 Assign",
        assignment_type: "NOP",
        cluster_area: "NOP MEDAN",
        pic_nop: "Nasrul Amin",
        reopen_number: "0",
      }),
    ],
    new Date("2026-09-13T08:00:00.000Z"),
    { pollingMode: true, ticketOnlyMode: true },
  );

  assert.equal(planReopened.sendable_tickets.length, 1);
  assert.equal(planReopened.sendable_tickets[0].order_id, "CC-YESTERDAY-1");
  assert.equal(planReopened.duplicate_tickets.length, 1);

  // 3. Ticket 2 escalated from NOP to SQA -> 1 sendable
  const planEscalated = await createSentTicketPlan(
    [
      ticket({
        order_id: "CC-YESTERDAY-2",
        business_status: "L2 Assign",
        assignment_type: "SQA",
        cluster_area: "SQA",
        reopen_number: "0",
      }),
    ],
    new Date("2026-09-13T08:00:00.000Z"),
    { pollingMode: true, ticketOnlyMode: true },
  );

  assert.equal(planEscalated.sendable_tickets.length, 1);
  assert.equal(planEscalated.sendable_tickets[0].order_id, "CC-YESTERDAY-2");
  assert.equal(planEscalated.sendable_tickets[0].escalated_from, "NOP MDN");

  context.cleanup();
});

test("plans unrecorded ticket as sendable so it is sent full first time", async () => {
  const context = setupStore("unrecorded-first-time");

  const plan = await createSentTicketPlan([
    ticket({
      order_id: "CC-FIRST-TIME",
      business_status: "IN PROGRESS",
      sla_status: "OUT SLA",
    }),
  ]);

  // Unrecorded in DB -> must be sent full (sendable: 1)
  assert.equal(plan.sendable_tickets.length, 1);
  assert.equal(plan.in_progress_reminder_tickets.length, 0);

  // Mark ticket as sent (now recorded in DB on 2026-09-13)
  await markTicketAsSent(
    ticket({
      order_id: "CC-FIRST-TIME",
      business_status: "IN PROGRESS",
      sla_status: "OUT SLA",
    }),
    { sourceJid: "source@g.us", targetJid: "target@g.us" },
  );

  // Next day run (2026-09-15) -> already in DB -> transitions to reminder!
  const planNextDay = await createSentTicketPlan(
    [
      ticket({
        order_id: "CC-FIRST-TIME",
        business_status: "IN PROGRESS",
        sla_status: "OUT SLA",
      }),
    ],
    new Date("2026-09-15T08:00:00.000Z"),
  );

  assert.equal(planNextDay.sendable_tickets.length, 0);
  assert.equal(planNextDay.in_progress_reminder_tickets.length, 1);
  assert.equal(planNextDay.out_sla_tickets.length, 1);

  context.cleanup();
});

test("formats NOP area summary message with counts across all 6 departments", () => {
  const tickets = [
    ...Array.from({ length: 4 }, () => ({ assignment_type: "SQA", cluster_area: "NOP ACEH" })),
    ...Array.from({ length: 10 }, () => ({ assignment_type: "SQA", cluster_area: "NOP BINJAI" })),
    ...Array.from({ length: 13 }, () => ({ assignment_type: "SQA", cluster_area: "NOP MEDAN" })),
    ...Array.from({ length: 3 }, () => ({ assignment_type: "SQA", cluster_area: "NOP PEMATANG SIANTAR" })),
    ...Array.from({ length: 5 }, () => ({ assignment_type: "SQA", cluster_area: "NOP RANTAU PRAPAT" })),
    ...Array.from({ length: 1 }, () => ({ assignment_type: "SQA", cluster_area: "NOP PADANG SIDEMPUAN" })),
    { assignment_type: "NOP", cluster_area: "NOP MEDAN" },
  ];

  const fixedDate = new Date("2026-10-08T09:00:00+07:00");
  const msg = formatNopAreaSummaryMessage(tickets, fixedDate);

  assert.equal(
    msg,
    [
      "*Summary Tiket CCM NOP Kamis 8 Oktober 2026*",
      "",
      "NOP ACEH : 4",
      "NOP BINJAI : 10",
      "NOP MEDAN : 13",
      "NOP PMS : 3",
      "NOP RAP : 5",
      "NOP PSP : 1",
    ].join("\n"),
  );
});

test("formats NOP area summary message for Monday 12 October 2026 scenario matching SQA follow-up counts", () => {
  const tickets = [
    ...Array.from({ length: 7 }, () => ({ assignment_type: "SQA", cluster_area: "NOP ACEH", pic_sqa: "Bg Ridha" })),
    ...Array.from({ length: 6 }, () => ({ assignment_type: "SQA", cluster_area: "NOP MEDAN", pic_sqa: "Bg Ahsan" })),
    ...Array.from({ length: 1 }, () => ({ assignment_type: "SQA", cluster_area: "NOP PADANG SIDEMPUAN", pic_sqa: "Bg Ahsan" })),
    ...Array.from({ length: 3 }, () => ({ assignment_type: "SQA", cluster_area: "NOP PEMATANG SIANTAR", pic_sqa: "Bg Fernando Pasaribu" })),
    ...Array.from({ length: 2 }, () => ({ assignment_type: "SQA", cluster_area: "NOP RANTAU PRAPAT", pic_sqa: "Bg Fernando Pasaribu" })),
    { assignment_type: "NOP", cluster_area: "NOP MEDAN" },
    { assignment_type: "NOP", cluster_area: "NOP BINJAI" },
  ];

  const mondayDate = new Date("2026-10-12T08:00:00+07:00");
  const msg = formatNopAreaSummaryMessage(tickets, mondayDate);

  assert.equal(
    msg,
    [
      "*Summary Tiket CCM NOP Senin 12 Oktober 2026*",
      "",
      "NOP ACEH : 7",
      "NOP BINJAI : 0",
      "NOP MEDAN : 6",
      "NOP PMS : 3",
      "NOP RAP : 2",
      "NOP PSP : 1",
    ].join("\n"),
  );
});
