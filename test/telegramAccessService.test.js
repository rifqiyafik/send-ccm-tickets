import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  formatTelegramRegisterRequest,
  getTelegramAccessDecision,
  isAuthorizedTelegramChat,
  listAuthorizedTelegramChats,
  registerTelegramChat,
} from "../src/services/telegramAccessService.js";

function setupTelegramAccessConfig(name) {
  const configPath = path.join("tmp", `${name}-telegram-access.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.rmSync(configPath, { force: true });
  process.env.TELEGRAM_ACCESS_CONFIG_PATH = configPath;

  return {
    configPath,
    cleanup() {
      fs.rmSync(configPath, { force: true });
      delete process.env.TELEGRAM_ACCESS_CONFIG_PATH;
    },
  };
}

test("registers Telegram group and allows it", async () => {
  const context = setupTelegramAccessConfig("group-register");

  const registered = await registerTelegramChat({
    chatId: "-1001234567890",
    label: "Grup Import Ticket",
    type: "group",
    registeredBy: "123456789",
  });

  assert.equal(registered.id, "-1001234567890");
  assert.equal(registered.label, "Grup Import Ticket");
  assert.equal(await isAuthorizedTelegramChat("-1001234567890"), true);
  assert.equal(await isAuthorizedTelegramChat("-1000000000000"), false);

  const list = await listAuthorizedTelegramChats();
  assert.equal(list.groups.length, 1);
  assert.equal(list.users.length, 0);

  context.cleanup();
});

test("registers Telegram private user separately from groups", async () => {
  const context = setupTelegramAccessConfig("user-register");

  await registerTelegramChat({
    chatId: "123456789",
    label: "Rifqi Admin",
    type: "private",
    registeredBy: "123456789",
  });

  const list = await listAuthorizedTelegramChats();
  assert.equal(list.groups.length, 0);
  assert.equal(list.users.length, 1);
  assert.equal(await isAuthorizedTelegramChat("123456789"), true);

  context.cleanup();
});

test("formats Telegram register request with approve command", () => {
  const text = formatTelegramRegisterRequest({
    chat: {
      id: "-1001234567890",
      type: "supergroup",
      title: "Import Ticket Group",
    },
    from: {
      first_name: "Rifqi",
      last_name: "Yafik",
    },
  });

  assert.match(text, /Telegram Whitelist Request/);
  assert.match(text, /Chat ID: `-1001234567890`/);
  assert.match(text, /\/register -1001234567890 Import Ticket Group/);
});

test("reports detailed Telegram access decision reasons", async () => {
  const context = setupTelegramAccessConfig("telegram-decision-reasons");

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

  const adminDecision = await getTelegramAccessDecision("999", {
    admin: true,
  });
  assert.equal(adminDecision.allowed, true);
  assert.equal(adminDecision.reason, "ADMIN");
  assert.equal(adminDecision.source_type, "private");

  const groupDecision = await getTelegramAccessDecision("-1001234567890");
  assert.equal(groupDecision.allowed, true);
  assert.equal(groupDecision.reason, "AUTHORIZED_GROUP");
  assert.equal(groupDecision.source_type, "group");

  const userDecision = await getTelegramAccessDecision("123456789");
  assert.equal(userDecision.allowed, true);
  assert.equal(userDecision.reason, "AUTHORIZED_USER");
  assert.equal(userDecision.source_type, "private");

  const unknownGroupDecision = await getTelegramAccessDecision("-1000000000000");
  assert.equal(unknownGroupDecision.allowed, false);
  assert.equal(unknownGroupDecision.reason, "GROUP_NOT_AUTHORIZED");

  const unknownUserDecision = await getTelegramAccessDecision("555");
  assert.equal(unknownUserDecision.allowed, false);
  assert.equal(unknownUserDecision.reason, "PRIVATE_USER_NOT_AUTHORIZED");

  context.cleanup();
});

test("does not authorize Telegram private id from group bucket", async () => {
  const context = setupTelegramAccessConfig("telegram-type-bucket");
  fs.writeFileSync(
    context.configPath,
    JSON.stringify(
      {
        authorized_groups: {
          "8477611126": {
            id: "8477611126",
            label: "Wrong Bucket",
            type: "group",
          },
        },
        authorized_users: {},
      },
      null,
      2,
    ),
  );

  const decision = await getTelegramAccessDecision("8477611126");
  assert.equal(decision.allowed, false);
  assert.equal(decision.source_type, "private");
  assert.equal(decision.reason, "PRIVATE_USER_NOT_AUTHORIZED");

  context.cleanup();
});
