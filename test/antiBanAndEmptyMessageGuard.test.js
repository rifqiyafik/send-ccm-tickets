import test from "node:test";
import assert from "node:assert/strict";

import {
  getReminderQueueConfig,
  getReminderPostSendDelay,
  getSummaryQueueConfig,
  getSummaryPostSendDelay,
} from "../src/services/messageQueueService.js";
import { getReopenReminderTickets } from "../src/services/ticketImportService.js";
import {
  markMessageAsRead,
  handleIncomingMessage,
} from "../src/handlers/whatsappMessageHandler.js";
import { normalizeJid } from "../src/utils/jid.js";

test("getReopenReminderTickets properly filters for NOP groups to avoid empty reminder preamble", () => {
  // Case 1: Tickets are InProgress, not ReOpen -> detailTickets must be empty
  const inProgressTickets = [
    {
      order_id: "CC-20260902-00000001",
      business_status: "InProgress",
      pic: "Rachmad S Siregar",
      assignment_type: "NOP",
    },
    {
      order_id: "CC-20260902-00000002",
      business_status: "InProgress",
      pic: "Adi Saputra Piliang",
      assignment_type: "NOP",
    },
  ];

  const reopenOnly = getReopenReminderTickets(inProgressTickets, {
    requirePicNop: true,
  });
  assert.equal(
    reopenOnly.length,
    0,
    "InProgress tickets should not trigger NOP reopen preamble reminder",
  );

  // Case 2: ReOpen ticket exists with PIC NOP & required fields -> detailTickets must return it
  const mixedTickets = [
    ...inProgressTickets,
    {
      order_id: "CC-20260902-00000003",
      business_status: "ReOpen",
      pic_nop: "Adi Saputra Piliang",
      site_id: "BIR185",
      reopen_number: "2",
      problem_analysis: "Kendala Sektor 1",
      assignment_type: "NOP",
    },
  ];

  const foundReopen = getReopenReminderTickets(mixedTickets, {
    requirePicNop: true,
  });
  assert.equal(foundReopen.length, 1);
  assert.equal(foundReopen[0].order_id, "CC-20260902-00000003");
});

test("Reminder jitter is strictly between 60s and 120s by default", () => {
  const config = getReminderQueueConfig();
  assert.equal(config.minDelayMs, 60000);
  assert.equal(config.maxDelayMs, 120000);

  for (let i = 0; i < 20; i++) {
    const delay = getReminderPostSendDelay();
    assert.ok(delay >= 60000, `Delay ${delay} should be >= 60,000ms (1 min)`);
    assert.ok(delay <= 120000, `Delay ${delay} should be <= 120,000ms (2 min)`);
  }
});

test("Summary jitter is strictly between 30s and 60s by default", () => {
  const config = getSummaryQueueConfig();
  assert.equal(config.minDelayMs, 30000);
  assert.equal(config.maxDelayMs, 60000);

  for (let i = 0; i < 20; i++) {
    const delay = getSummaryPostSendDelay();
    assert.ok(delay >= 30000, `Delay ${delay} should be >= 30,000ms (30s)`);
    assert.ok(delay <= 60000, `Delay ${delay} should be <= 60,000ms (60s)`);
  }
});

test("markMessageAsRead delegates to sock.readMessages and skips fromMe or disabled WA_AUTO_READ", async () => {
  let readCalled = false;
  let readKeys = [];

  const fakeSock = {
    async readMessages(keys) {
      readCalled = true;
      readKeys = keys;
    },
  };

  const incomingMsg = {
    key: {
      remoteJid: "120363000000000001@g.us",
      id: "MSG_12345",
      fromMe: false,
    },
  };

  // Case 1: fromMe should not be marked as read
  const fromMeResult = await markMessageAsRead(
    fakeSock,
    { key: { ...incomingMsg.key, fromMe: true } },
    { delayMs: 0 },
  );
  assert.equal(fromMeResult, false);
  assert.equal(readCalled, false);

  // Case 2: Normal incoming message should call sock.readMessages
  const readResult = await markMessageAsRead(fakeSock, incomingMsg, { delayMs: 0 });
  assert.equal(readResult, true);
  assert.equal(readCalled, true);
  assert.equal(readKeys[0].id, "MSG_12345");

  // Case 3: When WA_AUTO_READ is false
  const prevAutoRead = process.env.WA_AUTO_READ;
  try {
    process.env.WA_AUTO_READ = "false";
    readCalled = false;
    const disabledResult = await markMessageAsRead(fakeSock, incomingMsg, { delayMs: 0 });
    assert.equal(disabledResult, false);
    assert.equal(readCalled, false);
  } finally {
    if (prevAutoRead !== undefined) process.env.WA_AUTO_READ = prevAutoRead;
    else delete process.env.WA_AUTO_READ;
  }
});

test("WA_DISABLE_INCOMING=true completely ignores incoming WhatsApp commands and messages (Telegram-only mode)", async () => {
  const prevDisable = process.env.WA_DISABLE_INCOMING;
  process.env.WA_DISABLE_INCOMING = "true";

  let sentMessageCount = 0;
  const fakeSock = {
    async sendMessage() {
      sentMessageCount++;
    },
    async readMessages() {},
    sendPresenceUpdate() {},
  };

  const incomingEvent = {
    type: "notify",
    messages: [
      {
        key: {
          remoteJid: "120363000000000001@g.us",
          fromMe: false,
          id: "CMD_001",
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          conversation: ".status",
        },
      },
    ],
  };

  try {
    await handleIncomingMessage(fakeSock, incomingEvent);
    assert.equal(
      sentMessageCount,
      0,
      "Bot tidak boleh membalas atau memproses command WhatsApp apapun saat WA_DISABLE_INCOMING=true",
    );
  } finally {
    if (prevDisable !== undefined) {
      process.env.WA_DISABLE_INCOMING = prevDisable;
    } else {
      delete process.env.WA_DISABLE_INCOMING;
    }
  }
});

test("normalizeJid automatically fixes malformed double domain suffixes like @g.us@g.us", () => {
  assert.equal(
    normalizeJid("120363223022029506@g.us@g.us"),
    "120363223022029506@g.us",
  );
  assert.equal(
    normalizeJid("120363223022029506@g.us@g.us@g.us"),
    "120363223022029506@g.us",
  );
  assert.equal(
    normalizeJid("628123456789:12@s.whatsapp.net@s.whatsapp.net"),
    "628123456789@s.whatsapp.net",
  );
  assert.equal(
    normalizeJid("12345@lid@lid"),
    "12345@lid",
  );
});

test("hasMeaningfulLetters and isMeaningfulPayload reject empty and letterless messages", async () => {
  const { hasMeaningfulLetters, isMeaningfulPayload } = await import(
    "../src/utils/text.js"
  );

  // hasMeaningfulLetters
  assert.equal(hasMeaningfulLetters(""), false);
  assert.equal(hasMeaningfulLetters("   "), false);
  assert.equal(hasMeaningfulLetters("\n\r\t"), false);
  assert.equal(hasMeaningfulLetters("\u200B\uFEFF"), false);
  assert.equal(hasMeaningfulLetters("- - -"), false);
  assert.equal(hasMeaningfulLetters("123456789"), false);
  assert.equal(hasMeaningfulLetters("--- === ---"), false);
  assert.equal(hasMeaningfulLetters("CC-20260911-00000101"), true);
  assert.equal(hasMeaningfulLetters("Mohon dibantu"), true);
  assert.equal(hasMeaningfulLetters("12 Tiket"), true);

  // isMeaningfulPayload
  assert.equal(isMeaningfulPayload(null), false);
  assert.equal(isMeaningfulPayload(undefined), false);
  assert.equal(isMeaningfulPayload(""), false);
  assert.equal(isMeaningfulPayload("   "), false);
  assert.equal(isMeaningfulPayload({ text: "" }), false);
  assert.equal(isMeaningfulPayload({ text: "   " }), false);
  assert.equal(isMeaningfulPayload({ text: "\u200B" }), false);
  assert.equal(isMeaningfulPayload({ text: "---" }), false);
  assert.equal(isMeaningfulPayload({ text: "123456" }), false);
  assert.equal(isMeaningfulPayload({ edit: { id: "1" }, text: "" }), false);
  assert.equal(isMeaningfulPayload({ document: Buffer.alloc(0) }), false);

  assert.equal(isMeaningfulPayload({ text: "Tiket SQA MDN001" }), true);
  assert.equal(
    isMeaningfulPayload({
      document: Buffer.from("data"),
      fileName: "tickets.xlsx",
      caption: "File Tiket",
    }),
    true,
  );
  assert.equal(
    isMeaningfulPayload({ edit: { id: "1" }, text: "Progress 50%" }),
    true,
  );
});

test("createTelegramWhatsAppAdapter blocks empty or letterless message from reaching WhatsApp socket", async () => {
  const { createTelegramWhatsAppAdapter } = await import(
    "../src/handlers/telegramCommandHandler.js"
  );

  let waSentCount = 0;
  let sentPayload = null;
  const fakeWaSock = {
    async sendMessage(jid, payload) {
      waSentCount += 1;
      sentPayload = payload;
      return { key: { id: "123" } };
    },
  };

  const adapter = createTelegramWhatsAppAdapter({
    ensureWhatsAppReady: async () => fakeWaSock,
    getWhatsAppSocket: () => fakeWaSock,
    sourceChatId: "99999",
    sendMessage: async () => {},
    sendDocument: async () => {},
  });

  // 1. Kirim pesan kosong ke target WhatsApp -> harus diblokir
  const resEmpty = await adapter.sendMessage("120363000000000001@g.us", {
    text: "",
  });
  assert.equal(resEmpty, null);
  assert.equal(waSentCount, 0);

  // 2. Kirim pesan whitespace / tanpa huruf ke WhatsApp -> harus diblokir
  const resSpaces = await adapter.sendMessage("120363000000000001@g.us", {
    text: "   \u200B   ",
  });
  assert.equal(resSpaces, null);
  assert.equal(waSentCount, 0);

  const resSymbols = await adapter.sendMessage("120363000000000001@g.us", {
    text: "---",
  });
  assert.equal(resSymbols, null);
  assert.equal(waSentCount, 0);

  // 3. Kirim pesan valid dengan huruf -> harus lolos terkirim
  const resValid = await adapter.sendMessage("120363000000000001@g.us", {
    text: "Mohon dibantu bang Ahsan CC-20260911-00000101",
  });
  assert.ok(resValid);
  assert.equal(waSentCount, 1);
  assert.equal(
    sentPayload.text,
    "Mohon dibantu bang Ahsan CC-20260911-00000101",
  );
});



