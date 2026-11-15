import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { formatDailyInjectReminderMessage } from "../src/services/messageTemplateService.js";
import {
  createDailyReminderService,
  resolveDailyReminderChatIds,
} from "../src/services/dailyReminderService.js";

test("formatDailyInjectReminderMessage contains all required steps and attractive formatting", () => {
  const message = formatDailyInjectReminderMessage();

  assert.ok(message.includes("17:00 WIB"), "Harus menyebutkan waktu 17:00 WIB");
  assert.ok(message.includes("SQA Team"), "Harus menyapa SQA Team");
  assert.ok(message.includes("Regional 1"), "Harus menyebutkan filter Regional 1");
  assert.ok(message.includes("Customer Interaction Date"), "Harus memuat Customer Interaction Date");
  assert.ok(message.includes("Export All"), "Harus memuat panduan klik button Export All");
  assert.ok(message.includes(".inject"), "Harus memuat instruksi caption .inject");
  assert.ok(message.includes("database"), "Harus memuat info sinkronisasi ke database");
});

test("resolveDailyReminderChatIds respects env override, authorized groups, and fallback", async () => {
  // Test env override
  const originalEnv = process.env.TELEGRAM_DAILY_REMINDER_CHAT_IDS;
  process.env.TELEGRAM_DAILY_REMINDER_CHAT_IDS = "-100111,-100222";

  try {
    const ids = await resolveDailyReminderChatIds();
    assert.deepEqual(ids, ["-100111", "-100222"]);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.TELEGRAM_DAILY_REMINDER_CHAT_IDS;
    } else {
      process.env.TELEGRAM_DAILY_REMINDER_CHAT_IDS = originalEnv;
    }
  }

  // Test custom getTargetChatIds callback
  const customIds = await resolveDailyReminderChatIds({
    getTargetChatIds: async () => ["-100999"],
  });
  assert.deepEqual(customIds, ["-100999"]);
});

test("dailyReminderService sends at 17:00 WIB and prevents duplicate sending on the same day", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-test-"));
  const statePath = path.join(tmpDir, "daily_reminder_state.json");

  const sentMessages = [];
  const fakeBot = {
    sendMessage: async (chatId, text, options) => {
      sentMessages.push({ chatId, text, options });
      return { message_id: 123 };
    },
  };

  const service = createDailyReminderService({
    telegramBot: fakeBot,
    adminChatIds: ["-10012345"],
    statePath,
    targetHour: 17,
    targetMinute: 0,
    getTargetChatIds: async () => ["-10012345"],
  });

  // 1. Uji sebelum jam 17:00 WIB (misal jam 10:00:00 UTC = 17:00 WIB, jadi coba jam 09:59 UTC = 16:59 WIB)
  const timeBefore17 = new Date("2026-10-13T09:59:00.000Z"); // 16:59 WIB
  const resultBefore = await service.checkAndSendReminder(timeBefore17);
  assert.equal(resultBefore.sent, false);
  assert.equal(resultBefore.reason, "NOT_TIME_YET");
  assert.equal(sentMessages.length, 0);

  // 2. Uji saat tepat jam 17:00 WIB (10:00:00 UTC = 17:00:00 WIB)
  const timeAt17 = new Date("2026-10-13T10:00:00.000Z"); // 17:00 WIB
  const resultAt17 = await service.checkAndSendReminder(timeAt17);
  assert.equal(resultAt17.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, "-10012345");
  assert.ok(sentMessages[0].text.includes("17:00 WIB"));
  assert.ok(sentMessages[0].text.includes(".inject"));

  // Verifikasi file state tersimpan
  const savedState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(savedState.lastSentDate, "2026-10-13");

  // 3. Uji proteksi duplikasi: panggilan kedua di hari yang sama (misal jam 17:05 WIB)
  const timeAfter17 = new Date("2026-10-13T10:05:00.000Z"); // 17:05 WIB
  const resultDuplicate = await service.checkAndSendReminder(timeAfter17);
  assert.equal(resultDuplicate.sent, false);
  assert.equal(resultDuplicate.reason, "ALREADY_SENT_TODAY");
  assert.equal(sentMessages.length, 1, "Pesan tidak boleh bertambah (hanya dikirim sekali sehari)");

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("dailyReminderService triggerManual sends message to target chat immediately", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reminder-manual-test-"));
  const statePath = path.join(tmpDir, "daily_reminder_state.json");

  const sentMessages = [];
  const fakeBot = {
    sendMessage: async (chatId, text, options) => {
      sentMessages.push({ chatId, text, options });
      return { message_id: 456 };
    },
  };

  const service = createDailyReminderService({
    telegramBot: fakeBot,
    statePath,
    targetHour: 17,
    targetMinute: 0,
    getTargetChatIds: async () => ["-100888"],
  });

  const manualResult = await service.triggerManual("-100999");
  assert.equal(manualResult.sent, true);
  assert.deepEqual(manualResult.sentTo, ["-100999"]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, "-100999");

  // Status check
  const status = await service.getStatus();
  assert.equal(status.targetTime, "17:00 WIB");

  await fs.rm(tmpDir, { recursive: true, force: true });
});
