import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  getWhatsAppAccessDecision,
  isAllowedBotAccess,
  isAllowedGroup,
  isAllowedPrivateUser,
} from "../src/services/accessControlService.js";

function setupAccessConfig(name) {
  const configPath = path.join("tmp", `${name}-whatsapp-config.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        authorized_groups: {
          CcmTicket: {
            jid: "120363408099585884@g.us",
            label: "CCM Ticket",
          },
        },
        authorized_users: {
          RifqiPn: {
            jid: "6282160478546@s.whatsapp.net",
            label: "Rifqi",
          },
          RifqiLid: {
            jid: "35515252351004@lid",
            label: "Rifqi LID",
          },
        },
        target_groups: {},
        mentions: {},
      },
      null,
      2,
    ),
  );
  process.env.WHATSAPP_CONFIG_PATH = configPath;
  process.env.OWNER_JIDS = "";

  return {
    cleanup() {
      fs.rmSync(configPath, { force: true });
      delete process.env.WHATSAPP_CONFIG_PATH;
      delete process.env.OWNER_JIDS;
    },
  };
}

test("allows only whitelisted groups", () => {
  const context = setupAccessConfig("allowed-groups");

  assert.equal(isAllowedGroup("120363408099585884@g.us"), true);
  assert.equal(isAllowedGroup("120363000000000000@g.us"), false);
  assert.equal(
    isAllowedBotAccess({
      sourceJid: "120363408099585884@g.us",
      senderJid: "unknown@lid",
    }),
    true,
  );

  context.cleanup();
});

test("allows only whitelisted private users or owners", () => {
  const context = setupAccessConfig("allowed-private");

  assert.equal(isAllowedPrivateUser("6282160478546@s.whatsapp.net"), true);
  assert.equal(isAllowedPrivateUser("35515252351004@lid"), true);
  assert.equal(isAllowedPrivateUser("628000000000@s.whatsapp.net"), false);

  process.env.OWNER_JIDS = "109638183825591@lid";
  assert.equal(isAllowedPrivateUser("109638183825591@lid"), true);

  context.cleanup();
});

test("reports detailed WhatsApp access decision reasons", () => {
  const context = setupAccessConfig("decision-reasons");

  assert.deepEqual(
    getWhatsAppAccessDecision({
      sourceJid: "120363408099585884@g.us",
      senderJid: "628000000000@s.whatsapp.net",
    }),
    {
      allowed: true,
      platform: "whatsapp",
      source_type: "group",
      reason: "AUTHORIZED_GROUP",
      source_jid: "120363408099585884@g.us",
      sender_jid: "628000000000@s.whatsapp.net",
      owner: false,
    },
  );

  assert.equal(
    getWhatsAppAccessDecision({
      sourceJid: "120363000000000000@g.us",
      senderJid: "628000000000@s.whatsapp.net",
    }).reason,
    "GROUP_NOT_AUTHORIZED",
  );

  process.env.OWNER_JIDS = "109638183825591@lid";
  assert.equal(
    getWhatsAppAccessDecision({
      sourceJid: "109638183825591@lid",
      senderJid: "109638183825591@lid",
    }).reason,
    "OWNER",
  );

  assert.equal(
    getWhatsAppAccessDecision({
      sourceJid: "6282160478546@s.whatsapp.net",
      senderJid: "6282160478546@s.whatsapp.net",
    }).reason,
    "AUTHORIZED_USER",
  );

  assert.equal(
    getWhatsAppAccessDecision({
      sourceJid: "628000000000@s.whatsapp.net",
      senderJid: "628000000000@s.whatsapp.net",
    }).reason,
    "PRIVATE_USER_NOT_AUTHORIZED",
  );

  context.cleanup();
});
