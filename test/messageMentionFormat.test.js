import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { formatEscalationMessagePayload } from "../src/services/ticketImportService.js";

function setupMentionConfig() {
  const configPath = path.join("tmp", "mention-format-whatsapp-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        authorized_groups: {},
        authorized_users: {},
        target_groups: {},
        mentions: {
          Ferry: {
            jid: "35515252351004@lid",
            label: "Bg Ferry CCM",
          },
          Herman: {
            jid: "628136378970@s.whatsapp.net",
            label: "Bg Herman PIC SQA Telkomsel",
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

test("formats mentions with JID tokens and full mentioned JIDs", () => {
  const context = setupMentionConfig();

  const payload = formatEscalationMessagePayload({
    order_id: "CC-20260715-00000405",
    assignment_type: "SQA",
    ccm_handling: "Ferry",
    pic_sqa: "Herman",
    pic_nop: "",
    notes: "Notes",
    analysis_text: "Analysis",
    resolve_target_22h_text: "Kamis / 16 Jul 2026, 08:15:19 PM",
  });

  assert.match(payload.text, /@35515252351004/);
  assert.match(payload.text, /@628136378970/);
  assert.doesNotMatch(payload.text, /@35515252351004 Bg Ferry CCM/);
  assert.doesNotMatch(payload.text, /@628136378970 Bg Herman PIC SQA Telkomsel/);
  assert.deepEqual(payload.mentions, [
    "35515252351004@lid",
    "628136378970@s.whatsapp.net",
  ]);

  context.cleanup();
});

test("formats ReOpen tickets with short recheck message when L2 data exists", () => {
  const context = setupMentionConfig();

  const payload = formatEscalationMessagePayload({
    order_id: "CC-20260719-00000077",
    assignment_type: "SQA",
    business_status: "ReOpen",
    ccm_handling: "Ferry",
    pic_sqa: "Herman",
    pic_nop: "",
    notes: "Long normal notes should not be included",
    analysis_text: "Normal analysis should not be included",
    problem_analysis: "Performance KPI normal",
    resolve_target_22h_text: "Senin / 20 Jul 2026, 08:11:25 AM",
    use_reopen_message_format: true,
    reopen_number: "3",
    reopen_filled_columns: ["Assign Personal(L2 Assign)"],
  });

  assert.match(payload.text, /Mohon dibantu pengecekannya kembali ya bang @35515252351004/);
  assert.match(payload.text, /\*CC-20260719-00000077\*/);
  assert.match(payload.text, /CC bang @628136378970/);
  assert.match(payload.text, /\*Ticket Re-Open \(3 X\)\*/);
  assert.match(payload.text, /_Remark Problem Analysis:_\nPerformance KPI normal\nSLA DUE DATE 24H/);
  assert.match(payload.text, /SLA DUE DATE 24H : \*Senin \/ 20 Jul 2026, 08:11:25 AM\*/);
  assert.doesNotMatch(payload.text, /Long normal notes/);
  assert.doesNotMatch(payload.text, /Normal analysis/);
  assert.deepEqual(payload.mentions, [
    "35515252351004@lid",
    "628136378970@s.whatsapp.net",
  ]);

  context.cleanup();
});

test("formats NOP ReOpen tickets without SQA CC line", () => {
  const context = setupMentionConfig();

  const payload = formatEscalationMessagePayload({
    order_id: "CC-20260719-00000088",
    assignment_type: "NOP",
    business_status: "ReOpen",
    ccm_handling: "",
    pic_sqa: "",
    pic_nop: "Ferry",
    notes: "Long normal notes should not be included",
    analysis_text: "Normal analysis should not be included",
    problem_analysis:
      "Performance KPI beberapa hari terakhir disaat kejadian terlihat Normal dan tidak ada yang Anomali.",
    resolve_target_22h_text: "Senin / 20 Jul 2026, 08:11:25 AM",
    use_reopen_message_format: true,
    reopen_number: "2",
    reopen_filled_columns: ["Site ID(L2 Assign)"],
  });

  assert.match(payload.text, /Mohon dibantu pengecekannya kembali ya bang @35515252351004/);
  assert.match(payload.text, /\*CC-20260719-00000088\*/);
  assert.match(payload.text, /\*Ticket Re-Open \(2 X\)\*/);
  assert.match(
    payload.text,
    /_Remark Problem Analysis:_\nPerformance KPI beberapa hari terakhir disaat kejadian terlihat Normal/,
  );
  assert.match(payload.text, /SLA DUE DATE 24H : \*Senin \/ 20 Jul 2026, 08:11:25 AM\*/);
  assert.doesNotMatch(payload.text, /CC bang/);
  assert.doesNotMatch(payload.text, /Long normal notes/);
  assert.doesNotMatch(payload.text, /Normal analysis/);
  assert.deepEqual(payload.mentions, ["35515252351004@lid"]);

  context.cleanup();
});

test("formats OUT SLA In Progress tickets with short reminder message", () => {
  const context = setupMentionConfig();

  const payload = formatEscalationMessagePayload({
    order_id: "CC-20260721-00000172",
    assignment_type: "SQA",
    business_status: "In Progress",
    sla_status: "OUT SLA",
    ccm_handling: "Ferry",
    pic_sqa: "Herman",
    notes: "Long notes should not be included",
    analysis_text: "Long analysis should not be included",
    resolve_target_22h_text: "Rabu / 22 Jul 2026, 11:50:38 PM",
  });

  assert.match(payload.text, /Mohon dibantu bang @35515252351004/);
  assert.match(payload.text, /CC-20260721-00000172/);
  assert.match(
    payload.text,
    /SLA DUE DATE 24H : \*Rabu \/ 22 Jul 2026, 11:50:38 PM\*/,
  );
  assert.doesNotMatch(payload.text, /Long notes/);
  assert.doesNotMatch(payload.text, /Long analysis/);
  assert.doesNotMatch(payload.text, /CC bang/);
  assert.deepEqual(payload.mentions, ["35515252351004@lid"]);

  context.cleanup();
});
