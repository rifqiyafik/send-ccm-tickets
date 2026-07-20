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
