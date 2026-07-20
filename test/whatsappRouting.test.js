import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getTargetGroupKey, resolveTargetJid } from "../src/config/whatsappRouting.js";

function setupRoutingConfig(name, targetGroups = {}) {
  const configPath = path.join("tmp", `${name}-whatsapp-config.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        authorized_groups: {},
        authorized_users: {},
        target_groups: targetGroups,
        mentions: {},
      },
      null,
      2,
    ),
  );
  process.env.WHATSAPP_CONFIG_PATH = configPath;
  process.env.WHATSAPP_GROUPS = "";

  return {
    cleanup() {
      fs.rmSync(configPath, { force: true });
      delete process.env.WHATSAPP_CONFIG_PATH;
      delete process.env.WHATSAPP_GROUPS;
    },
  };
}

test("returns null when target group JID is not configured", () => {
  const context = setupRoutingConfig("missing-target", {
    SQA: {
      jid: "",
      label: "Service Quality Assurance Sumbagut",
    },
  });

  assert.equal(
    resolveTargetJid({
      order_id: "CC-1",
      assignment_type: "SQA",
      cluster_area: "NOP MEDAN",
      nsa: "MEDAN",
      pic: "Ferry",
    }),
    null,
  );

  context.cleanup();
});

test("resolves configured target group JID", () => {
  const context = setupRoutingConfig("configured-target", {
    SQA: {
      jid: "120363408099585884@g.us",
      label: "Service Quality Assurance Sumbagut",
    },
  });

  assert.equal(
    getTargetGroupKey({
      assignment_type: "SQA",
      cluster_area: "NOP MEDAN",
    }),
    "SQA",
  );
  assert.equal(
    resolveTargetJid({
      order_id: "CC-1",
      assignment_type: "SQA",
      cluster_area: "NOP MEDAN",
      nsa: "MEDAN",
      pic: "Ferry",
    }),
    "120363408099585884@g.us",
  );

  context.cleanup();
});
