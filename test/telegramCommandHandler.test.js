import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import writeXlsxFile from "write-excel-file/node";

import { closeDatabasePool } from "../src/services/databaseService.js";
import { createTelegramCommandHandler } from "../src/handlers/telegramCommandHandler.js";
import { registerTelegramChat } from "../src/services/telegramAccessService.js";

function setupTelegramAccessConfig(name) {
  const configPath = path.join("tmp", `${name}-telegram-access.json`);
  const runtimeEnvPath = path.join("tmp", `${name}-runtime-env.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.rmSync(configPath, { force: true });
  fs.rmSync(runtimeEnvPath, { force: true });
  process.env.TELEGRAM_ACCESS_CONFIG_PATH = configPath;
  process.env.APP_RUNTIME_ENV_PATH = runtimeEnvPath;
  delete process.env.WHATSAPP_CONFIG_PATH;

  return {
    configPath,
    cleanup() {
      fs.rmSync(configPath, { force: true });
      fs.rmSync(runtimeEnvPath, { force: true });
      delete process.env.TELEGRAM_ACCESS_CONFIG_PATH;
      delete process.env.APP_RUNTIME_ENV_PATH;
      delete process.env.WHATSAPP_CONFIG_PATH;
    },
  };
}

function createTextUpdate({ chatId, text, type = "private" }) {
  return {
    message: {
      text,
      chat: {
        id: chatId,
        type,
        title: type === "private" ? undefined : "Approved Group",
      },
      from: {
        id: "123",
        first_name: "Tester",
      },
    },
  };
}

function createMockRuntime(overrides = {}) {
  const sentMessages = [];
  const whatsappSession = {
    async completePendingLoginName() {
      return null;
    },
    async completePendingSessionSwitch() {
      return null;
    },
    async listSessions() {
      return "sessions list";
    },
    async login(_chatId, argument) {
      return `login allowed: ${argument || "-"}`;
    },
    async stop(argument) {
      return `stop allowed: ${argument || "-"}`;
    },
    async logout(argument) {
      return `logout called: ${argument || "-"}`;
    },
    async deleteSession(argument) {
      return `delete called: ${argument || "-"}`;
    },
    getStatus() {
      return {
        running: false,
        user: null,
        active_session: null,
        authDir: "",
        qr_subscribers: 0,
      };
    },
    ...overrides.whatsappSession,
  };
  const handler = createTelegramCommandHandler({
    config: {
      admin_chat_ids: ["999"],
      ...overrides.config,
    },
    whatsappSession,
    ticketPolling: overrides.ticketPolling,
    dailyReminder: overrides.dailyReminder,
  });
  const tools = {
    async downloadFile() {
      return Buffer.from("");
    },
    async sendDocument() {},
    async sendMessage(chatId, text, options) {
      sentMessages.push({ chatId, text, options });
    },
  };

  return { handler, sentMessages, tools };
}

test("allows authorized Telegram group to use login command", async () => {
  const context = setupTelegramAccessConfig("handler-authorized-group-login");
  await registerTelegramChat({
    chatId: "-1001234567890",
    label: "Approved Group",
    type: "group",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "-1001234567890",
      text: "/login",
      type: "supergroup",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /login allowed: -/);
  assert.doesNotMatch(sentMessages[0].text, /hanya untuk admin/i);

  context.cleanup();
});

test("allows authorized Telegram private user to use login command", async () => {
  const context = setupTelegramAccessConfig("handler-authorized-user-login");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/login 1",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /login allowed: 1/);
  assert.doesNotMatch(sentMessages[0].text, /hanya untuk admin/i);

  context.cleanup();
});

test("keeps logout admin-only for authorized Telegram chat", async () => {
  const context = setupTelegramAccessConfig("handler-logout-admin-only");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/logout",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /hanya untuk admin/i);
  assert.doesNotMatch(sentMessages[0].text, /logout called/);

  context.cleanup();
});

test("allows authorized Telegram chat to inspect active environment", async () => {
  const context = setupTelegramAccessConfig("handler-env-status");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/env",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Environment Aktif/);
  assert.match(sentMessages[0].text, /whatsapp\.json/);

  context.cleanup();
});

test("allows only Telegram admin to change runtime environment", async () => {
  const context = setupTelegramAccessConfig("handler-change-env-admin-only");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/change_env development",
    }),
    tools,
  );
  await handler(
    createTextUpdate({
      chatId: "999",
      text: "/change_env development",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[0].text, /hanya untuk admin/i);
  assert.match(sentMessages[1].text, /Environment berhasil diganti/);
  assert.match(sentMessages[1].text, /development/);

  context.cleanup();
});

test("shows runtime environment usage when change env argument is missing", async () => {
  const context = setupTelegramAccessConfig("handler-change-env-usage");

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "999",
      text: "/change_env",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Ganti Environment WhatsApp/);
  assert.match(sentMessages[0].text, /change_env production/);
  assert.match(sentMessages[0].text, /change_env development/);

  context.cleanup();
});

test("returns command error message when authorized login fails", async () => {
  const context = setupTelegramAccessConfig("handler-login-error-reply");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime({
    whatsappSession: {
      async login() {
        throw new Error("Session lock failed");
      },
    },
  });
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/login 1",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Command gagal diproses/);
  assert.match(sentMessages[0].text, /Session lock failed/);

  context.cleanup();
});

test("returns group help guide for group chat and personal guide for private chat", async () => {
  const context = setupTelegramAccessConfig("handler-help-separation");
  await registerTelegramChat({
    chatId: "-1001234567890",
    label: "Approved Group",
    type: "group",
    registeredBy: "999",
  });
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();

  // Test Group /help
  await handler(
    createTextUpdate({
      chatId: "-1001234567890",
      text: "/help",
      type: "supergroup",
    }),
    tools,
  );
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Panduan Bot Kirim CCM Ticket \(Grup Telegram\)/);
  assert.match(sentMessages[0].text, /Cek Koneksi WhatsApp Bot/);

  // Test Personal /help
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/help",
      type: "private",
    }),
    tools,
  );
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /Admin Command Center \(Personal Guide\)/);
  assert.match(sentMessages[1].text, /WhatsApp Session Management/);

  context.cleanup();
});

test("returns start greeting and features overview for /start command", async () => {
  const context = setupTelegramAccessConfig("handler-start-greeting");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();

  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/start",
      type: "private",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Selamat Datang di CCM Ticket Bot!/);
  assert.match(sentMessages[0].text, /Fitur Utama Bot:/);
  assert.match(sentMessages[0].text, /Ketik.*\/help.*panduan/);

  context.cleanup();
});

test("handles /remind_inject command and triggers manual reminder", async () => {
  const context = setupTelegramAccessConfig("handler-remind-inject");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  let triggeredChatId = null;
  const dailyReminder = {
    async triggerManual(chatId) {
      triggeredChatId = chatId;
      return { sent: true, sentTo: ["123456789"], failedTo: [] };
    },
  };

  const { handler, sentMessages, tools } = createMockRuntime({
    dailyReminder,
  });

  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/remind_inject",
      type: "private",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Pesan Reminder Berhasil Dikirim/);

  context.cleanup();
});

test("handles document with caption .inject and sends repetitive site alert", async () => {
  const originalPgHost = process.env.PG_HOST;
  delete process.env.PG_HOST;
  const context = setupTelegramAccessConfig("handler-inject-repetitive");
  try {
    await registerTelegramChat({
      chatId: "123456789",
      label: "Approved User",
      type: "private",
      registeredBy: "999",
    });

    const columns = [
      { value: "Order ID" },
      { value: "Ticket Id" },
      { value: "Create Time" },
      { value: "Order Status" },
      { value: "Assign to L2(L2 Assign)" },
      { value: "site_id1(L1 Assign)" },
      { value: "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)" },
      { value: "Kabupaten/Kota(Create Ticket)" },
    ];

    const rows = [
      columns,
      [
        { value: "1-INJ-001" },
        { value: "INC-INJ-001" },
        { value: "2026-11-13 08:00:00" },
        { value: "running" },
        { value: "group:Network Operations and Productivity Medan" },
        { value: "MAK002" },
        { value: "Internet lambat total di kantor camat" },
        { value: "KOTA MEDAN" },
      ],
      [
        { value: "1-INJ-002" },
        { value: "INC-INJ-002" },
        { value: "2026-11-13 09:30:00" },
        { value: "running" },
        { value: "group:Network Operations and Productivity Medan" },
        { value: "MAK002" },
        { value: "Sinyal hilang timbul sejak pagi" },
        { value: "KOTA MEDAN" },
      ],
    ];

    const excelBuffer = await writeXlsxFile(rows, { buffer: true });

    const { handler, sentMessages, tools } = createMockRuntime();
    tools.downloadFile = async () => excelBuffer;

    const documentUpdate = {
      message: {
        caption: ".inject",
        chat: {
          id: "123456789",
          type: "private",
        },
        from: {
          id: "123",
          first_name: "Tester",
        },
        document: {
          file_id: "doc-123",
          file_name: "INAP_TEST.xlsx",
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      },
    };

    await handler(documentUpdate, tools);

    // Verifikasi laporan inject terkirim
    const injectReport = sentMessages.find(
      (m) => m.text && m.text.includes("Injeksi Data Master Tiket Berhasil"),
    );
    assert.ok(injectReport, "Laporan injeksi master harus terkirim");

    // Verifikasi alert komplain repetitif site ID terkirim ke chat pengirim
    const repetitiveAlert = sentMessages.find(
      (m) => m.text && m.text.includes("KOMPLAIN REPETITIF SITE ID"),
    );
    assert.ok(repetitiveAlert, "Alert komplain repetitif site ID harus terkirim ke pengirim");
    assert.ok(repetitiveAlert.text.includes("MAK002"));
    assert.ok(repetitiveAlert.text.includes("1-INJ-001"));
    assert.ok(repetitiveAlert.text.includes("1-INJ-002"));
    assert.ok(repetitiveAlert.text.includes("Internet lambat total di kantor camat"));
    assert.ok(repetitiveAlert.text.includes("Sinyal hilang timbul sejak pagi"));
  } finally {
    context.cleanup();
    if (originalPgHost !== undefined) {
      process.env.PG_HOST = originalPgHost;
    }
  }
});

test.after(async () => {
  await closeDatabasePool();
});
