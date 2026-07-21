import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createSentTicketPlan,
  formatSentTicketPlanReport,
  formatSqaAreaFollowUpMessage,
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
      },
    },
  });

  const plan = await createSentTicketPlan(
    [ticket({ business_status: "In Progress" })],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.duplicate_tickets.length, 1);
  assert.match(formatSentTicketPlanReport(plan), /Tiket duplicate dilewati: 1/);
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
      },
    },
  });

  const plan = await createSentTicketPlan(
    [ticket({ business_status: "ReOpen" })],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 1);
  assert.equal(plan.reopened_tickets.length, 1);
  assert.equal(plan.duplicate_tickets.length, 0);

  context.cleanup();
});

test("skips OUT SLA ticket before duplicate business-status check", async () => {
  const context = setupStore("out-sla-ticket", {
    version: 1,
    tickets: {
      "CC-1": {
        order_id: "CC-1",
        business_status: "IN PROGRESS",
        sla_status: "IN SLA",
        sent_at: "2026-07-21T00:00:00.000Z",
      },
    },
  });

  const plan = await createSentTicketPlan(
    [ticket({ business_status: "ReOpen", sla_status: "OUT SLA" })],
    new Date("2026-07-21T01:00:00.000Z"),
  );

  assert.equal(plan.sendable_tickets.length, 0);
  assert.equal(plan.reopened_tickets.length, 0);
  assert.equal(plan.out_sla_tickets.length, 1);

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
