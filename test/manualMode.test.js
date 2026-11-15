import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createTelegramCommandHandler,
} from "../src/handlers/telegramCommandHandler.js";
import {
  resolveTelegramTargetChatId,
  getTelegramTargetGroups,
} from "../src/services/telegramAccessService.js";
import {
  getGroupKeyByJid,
  getMentionNameByJid,
} from "../src/config/appConfig.js";

function setupContext(name) {
  const baseDir = path.join("tmp", name);
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });

  const telegramConfigPath = path.join(baseDir, "telegram.json");
  fs.writeFileSync(
    telegramConfigPath,
    JSON.stringify(
      {
        authorized_groups: {
          "-1001234567890": {
            id: "-1001234567890",
            label: "Test Group",
            type: "group",
          },
        },
        authorized_users: {
          "5085979770": {
            id: "5085979770",
            label: "Admin User",
            type: "user",
          },
        },
        target_groups: {
          "SQA": {
            id: "-1009999999991",
            label: "SQA Telegram Group",
          },
          "NOP ACEH": {
            id: "-1009999999992",
            label: "NOP Aceh Telegram Group",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  process.env.TELEGRAM_ACCESS_CONFIG_PATH = telegramConfigPath;

  return {
    cleanup() {
      delete process.env.TELEGRAM_ACCESS_CONFIG_PATH;
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

test("resolveTelegramTargetChatId returns configured Telegram group ID", async () => {
  const context = setupContext("manual-mode-resolve");

  const sqaTarget = await resolveTelegramTargetChatId("SQA");
  assert.equal(sqaTarget, "-1009999999991");

  const nopAcehTarget = await resolveTelegramTargetChatId("NOP ACEH");
  assert.equal(nopAcehTarget, "-1009999999992");

  const unconfiguredTarget = await resolveTelegramTargetChatId("NOP MEDAN");
  assert.equal(unconfiguredTarget, null);

  context.cleanup();
});

test("manual mode processes document without requiring active WhatsApp session", async () => {
  const context = setupContext("manual-mode-doc");
  const sentMessages = [];
  const sentDocuments = [];

  const handler = createTelegramCommandHandler({
    config: {
      admin_chat_ids: ["5085979770"],
    },
    whatsappSession: {
      ensureReady: async () => {
        throw new Error("WhatsApp socket should NOT be called in manual mode!");
      },
      getSocket: () => null,
    },
  });

  // Create a sample valid xlsx buffer or mock
  // We can test caption parsing and rejection/acceptance
  let ensureReadyCalled = false;
  const mockWhatsappSession = {
    ensureReady: async () => {
      ensureReadyCalled = true;
    },
    getSocket: () => null,
  };

  const manualHandler = createTelegramCommandHandler({
    config: {
      admin_chat_ids: ["5085979770"],
    },
    whatsappSession: mockWhatsappSession,
  });

  // 1. Sending document with .update manual
  await manualHandler(
    {
      message: {
        chat: { id: "5085979770", type: "private" },
        from: { id: "5085979770", username: "admin" },
        caption: ".update manual",
        document: {
          file_id: "mock_file_123",
          file_name: "test.xlsx",
          mime_type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      },
    },
    {
      downloadFile: async () => Buffer.from("mock excel content"),
      sendDocument: async (chatId, doc, meta) => {
        sentDocuments.push({ chatId, doc, meta });
      },
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 101 };
      },
      editMessageText: async () => {},
    },
  );

  // In manual mode, ensureReady should NOT be called!
  assert.equal(ensureReadyCalled, false);

  // Reception message should mention Mode Manual
  const receptionMsg = sentMessages.find((m) =>
    m.text.includes("Mode .update (Mode Manual / Telegram Only)"),
  );
  assert.ok(receptionMsg, "Reception message should acknowledge Mode Manual");

  context.cleanup();
});

test("replaceJidMentionsWithLabels replaces phone numbers with contact names for Telegram", async () => {
  const baseDir = path.join("tmp", "manual-mode-mentions");
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });

  const waConfigPath = path.join(baseDir, "whatsapp.json");
  fs.writeFileSync(
    waConfigPath,
    JSON.stringify(
      {
        mentions: {
          Ferry: {
            jid: "6282160478546@s.whatsapp.net",
            label: "Bg Ferry CCM",
          },
          Herman: {
            jid: "62811704400@s.whatsapp.net",
            label: "Bg Herman PIC SQA Telkomsel",
          },
        },
      },
      null,
      2,
    ),
  );
  process.env.WHATSAPP_CONFIG_PATH = waConfigPath;

  const { replaceJidMentionsWithLabels } = await import(
    "../src/config/appConfig.js"
  );

  const rawText = [
    "Mohon dibantu bang @6282160478546",
    "CC-20260818-00000019",
    "CC bang @62811704400",
    "",
    "CC-20260818-00000019",
  ].join("\n");

  const formatted = replaceJidMentionsWithLabels(rawText);
  delete process.env.WHATSAPP_CONFIG_PATH;
  fs.rmSync(baseDir, { recursive: true, force: true });

  assert.ok(
    formatted.includes("Mohon dibantu bang @Bg Ferry CCM"),
    "Phone number 6282160478546 should be replaced with @Bg Ferry CCM",
  );
  assert.ok(
    formatted.includes("CC bang @Bg Herman PIC SQA Telkomsel"),
    "Phone number 62811704400 should be replaced with @Bg Herman PIC SQA Telkomsel",
  );
});


