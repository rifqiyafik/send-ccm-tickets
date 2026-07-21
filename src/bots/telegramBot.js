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

async function callTelegramFileApi(token, filePath) {
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${filePath}`,
  );

  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
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

  async function sendDocument(chatId, document, options = {}) {
    logger.info("Sending Telegram document", {
      chatId: String(chatId),
      fileName: options.fileName || options.filename || "-",
      bytes: Buffer.isBuffer(document) ? document.length : undefined,
    });

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      "document",
      new Blob([document], {
        type:
          options.mimetype ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      options.fileName || options.filename || "document.xlsx",
    );

    if (options.caption) {
      form.append("caption", options.caption);
    }
    if (options.parse_mode) {
      form.append("parse_mode", options.parse_mode);
    }

    const response = await fetch(buildTelegramUrl(config.bot_token, "sendDocument"), {
      method: "POST",
      body: form,
    });
    const body = await response.json();
    if (!response.ok || !body.ok) {
      const message = body.description || response.statusText;
      throw new Error(`Telegram API sendDocument failed: ${message}`);
    }

    return body.result;
  }

  async function downloadFile(fileId) {
    logger.info("Downloading Telegram file", { fileId });
    const file = await callTelegramApi(config.bot_token, "getFile", {
      file_id: fileId,
    });
    const buffer = await callTelegramFileApi(config.bot_token, file.file_path);
    logger.info("Telegram file downloaded", {
      fileId,
      filePath: file.file_path,
      bytes: buffer.length,
    });
    return buffer;
  }

  async function pollOnce() {
    const updates = await callTelegramApi(config.bot_token, "getUpdates", {
      offset,
      timeout: config.poll_timeout_seconds,
      allowed_updates: ["message"],
    });

    for (const update of updates) {
      offset = update.update_id + 1;
      await handleUpdate(update, { downloadFile, sendDocument, sendMessage });
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
    sendDocument,
    start,
    stop,
    downloadFile,
  };
}
