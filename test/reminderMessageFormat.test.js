import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  formatReminderMessagePayload,
  formatTargetGroupOpeningMessage,
  formatUpdateTicketFileName,
} from "../src/services/ticketImportService.js";

function setupReminderConfig() {
  const configPath = path.join("tmp", "reminder-format-whatsapp-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        authorized_groups: {},
        authorized_users: {},
        target_groups: {},
        mentions: {
          "Jonthala MK Tambunan": {
            jid: "628111111111@s.whatsapp.net",
            label: "Bg Jonthala MK Tambunan",
          },
        },
      },
      null,
      2,
    ),
  );
  process.env.WHATSAPP_CONFIG_PATH = configPath;

  return {
    cleanup() {
      fs.rmSync(configPath, { force: true });
      delete process.env.WHATSAPP_CONFIG_PATH;
    },
  };
}

test("formats target group opening message", () => {
  const text = formatTargetGroupOpeningMessage();

  assert.match(text, /Assalamualaikum,/);
  assert.match(text, /Semangat Pagi dan Semangat Sehat,/);
  assert.match(text, /Dear Bapak Manager dan Tim,/);
  assert.match(text, /https:\/\/10\.62\.7\.112:31943\/portal-web\/portal\/homepage\.html/);
});

test("formats update ticket file name with Indonesian month and period", () => {
  const fileName = formatUpdateTicketFileName(new Date(2026, 6, 20, 8, 0, 0));

  assert.equal(fileName, "Update Ticket 20 Juli Pagi.xlsx");
});

test("formats SQA reminder summary and ReOpen details", () => {
  const payload = formatReminderMessagePayload([
    {
      assignment_type: "SQA",
      sla_status: "IN SLA",
      nsa: "ACEH",
      city: "ACEH BESAR",
      order_id: "CC-20260622-00000265",
      site_id: "JHO293",
      reopen_number: "9",
      problem_analysis:
        "Performance KPI beberapa hari terakhir disaat kejadian terlihat Normal dan tidak ada yang Anomali.",
    },
    {
      assignment_type: "SQA",
      sla_status: "OUT SLA",
      nsa: "MEDAN",
      city: "KOTA MEDAN",
      order_id: "CC-20260718-00000161",
      site_id: "LBP284",
      reopen_number: "2",
      problem_analysis: "Performance KPI di beberapa hari terlihat ada issue spike availability.",
    },
  ]);

  assert.match(payload.text, /Remind Ticket CX Open:/);
  assert.match(payload.text, /Group \| Total Ticket \| In SLA \| Out SLA/);
  assert.match(payload.text, /SQA \| 2 \| 1 \| 1/);
  assert.match(
    payload.text,
    /ACEH \| CC-20260622-00000265 \| JHO293 \| 9 \| Performance KPI/,
  );
  assert.deepEqual(payload.mentions, []);
});

test("formats NOP reminder with PIC mention", () => {
  const context = setupReminderConfig();
  const payload = formatReminderMessagePayload([
    {
      assignment_type: "NOP",
      sla_status: "OUT SLA",
      cluster_area: "NOP BINJAI",
      order_id: "CC-20260502-00000145",
      site_id: "CAG008",
      reopen_number: "2",
      problem_analysis: "Keluhan jaringan bukan di Binjai tetapi di Propinsi Riau",
      pic_nop: "Jonthala MK Tambunan",
    },
  ]);

  assert.match(payload.text, /Remind ticket CX Open :/);
  assert.match(payload.text, /NOP \| Total Ticket \| In SLA \| Out SLA/);
  assert.match(payload.text, /BJI \| 1 \| 0 \| 1/);
  assert.match(
    payload.text,
    /@628111111111 \| CC-20260502-00000145 \| CAG008 \| 2 \| Keluhan jaringan/,
  );
  assert.deepEqual(payload.mentions, ["628111111111@s.whatsapp.net"]);

  context.cleanup();
});

test("omits NOP ReOpen detail table when there are no ReOpen details", () => {
  const payload = formatReminderMessagePayload([
    {
      assignment_type: "NOP",
      sla_status: "IN SLA",
      cluster_area: "NOP PEMATANGSIANTAR",
      order_id: "CC-20260721-00000001",
      site_id: "PMS001",
      reopen_number: "",
      problem_analysis: "",
      pic_nop: "Jonthala MK Tambunan",
    },
  ]);

  assert.match(payload.text, /Remind ticket CX Open :/);
  assert.match(payload.text, /NOP \| Total Ticket \| In SLA \| Out SLA/);
  assert.match(payload.text, /PMS \| 1 \| 1 \| 0/);
  assert.doesNotMatch(
    payload.text,
    /PIC NOP \| Nomor Ticket \| Site ID \| Count ReOpen \| Remark ReOpen/,
  );
  assert.deepEqual(payload.mentions, []);
});
