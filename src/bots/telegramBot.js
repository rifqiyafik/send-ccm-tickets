import { createLogger } from "../utils/logger.js";

const logger = createLogger("telegramBot");

function buildTelegramUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function callTelegramApi(token, method, payload = {}) {
  const response = await fetch(buildTelegramUrl(token, method), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!response.ok || !body.ok) {
    const message = body.description || response.statusText;
    throw new Error(`Telegram API ${method} failed: ${message}`);
  }

  return body.result;
}

// #penjelasan: bot Telegram raw long-polling tanpa dependency tambahan; semua command masuk ke handler.
export function createTelegramBot({ config, handleUpdate }) {
  let stopped = false;
  let offset = 0;

  async function sendMessage(chatId, text, options = {}) {
    logger.info("Sending Telegram message", {
      chatId: String(chatId),
      length: String(text || "").length,
    });

    return callTelegramApi(config.bot_token, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
  }

  async function pollOnce() {
    const updates = await callTelegramApi(config.bot_token, "getUpdates", {
      offset,
      timeout: config.poll_timeout_seconds,
      allowed_updates: ["message"],
    });

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update, { sendMessage });
    }
  }

  async function start() {
    if (!config.bot_token) {
      throw new Error("TELEGRAM_BOT_TOKEN belum diisi.");
    }

    logger.info("Starting Telegram polling bot");
    stopped = false;
    try {
      await callTelegramApi(config.bot_token, "deleteWebhook", {
        drop_pending_updates: false,
      });
    } catch (error) {
      logger.warn("Telegram deleteWebhook failed before polling", {
        message: error.message,
      });
    }

    while (!stopped) {
      try {
        await pollOnce();
      } catch (error) {
        logger.error("Telegram polling error", error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  function stop() {
    logger.info("Stopping Telegram polling bot");
    stopped = true;
  }

  return {
    sendMessage,
    start,
    stop,
  };
}
