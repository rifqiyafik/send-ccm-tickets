import { createLogger } from "../utils/logger.js";

const logger = createLogger("telegramBot");

function buildTelegramUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function callTelegramApi(token, method, payload = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await fetch(buildTelegramUrl(token, method), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (networkErr) {
      if (attempt < maxRetries) {
        const waitMs = (attempt + 1) * 2000;
        logger.warn(
          `Telegram API ${method} network error (${networkErr.message}), retrying after ${waitMs}ms`,
          {
            attempt: attempt + 1,
            chatId: payload.chat_id,
          },
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw networkErr;
    }

    const body = await response.json();
    if (response.ok && body.ok) {
      return body.result;
    }

    const isRateLimit =
      response.status === 429 ||
      body.error_code === 429 ||
      /too many requests/i.test(body.description || "");

    if (isRateLimit && attempt < maxRetries) {
      const retryAfterSec =
        body.parameters?.retry_after ||
        Number((body.description || "").match(/retry after (\d+)/i)?.[1]) ||
        3;
      const waitMs = (Math.min(retryAfterSec, 60) + 1) * 1000;
      logger.warn(
        `Telegram API ${method} rate-limited (429), retrying after ${waitMs}ms`,
        {
          attempt: attempt + 1,
          retryAfterSec,
          chatId: payload.chat_id,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    const message = body.description || response.statusText;
    throw new Error(`Telegram API ${method} failed: ${message}`);
  }
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

export function splitTextIntoTelegramChunks(text, maxChunkLength = 4000) {
  if (!text || text.length <= maxChunkLength) return [String(text || "")];
  const lines = String(text).split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      if (line.length > maxChunkLength) {
        for (let i = 0; i < line.length; i += maxChunkLength) {
          chunks.push(line.slice(i, i + maxChunkLength));
        }
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [text];
}

// #penjelasan: bot Telegram raw long-polling tanpa dependency tambahan; semua command masuk ke handler.
export function createTelegramBot({ config, handleUpdate }) {
  let stopped = false;
  let offset = 0;

  async function sendMessage(chatId, text, options = {}) {
    const rawText = String(text ?? "");
    logger.info("Sending Telegram message", {
      chatId: String(chatId),
      length: rawText.length,
    });

    if (rawText.length > 4000) {
      const chunks = splitTextIntoTelegramChunks(rawText, 4000);
      let lastResult = null;
      for (const chunk of chunks) {
        lastResult = await callTelegramApi(config.bot_token, "sendMessage", {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
          ...options,
        });
      }
      return lastResult;
    }

    return callTelegramApi(config.bot_token, "sendMessage", {
      chat_id: chatId,
      text: rawText,
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

    for (let attempt = 0; attempt <= 3; attempt++) {
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

      const response = await fetch(
        buildTelegramUrl(config.bot_token, "sendDocument"),
        {
          method: "POST",
          body: form,
        },
      );
      const body = await response.json();
      if (response.ok && body.ok) {
        return body.result;
      }

      const isRateLimit =
        response.status === 429 ||
        body.error_code === 429 ||
        /too many requests/i.test(body.description || "");

      if (isRateLimit && attempt < 3) {
        const retryAfterSec =
          body.parameters?.retry_after ||
          Number((body.description || "").match(/retry after (\d+)/i)?.[1]) ||
          3;
        const waitMs = (Math.min(retryAfterSec, 60) + 1) * 1000;
        logger.warn(
          `Telegram API sendDocument rate-limited (429), retrying after ${waitMs}ms`,
          {
            attempt: attempt + 1,
            retryAfterSec,
            chatId,
          },
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      const message = body.description || response.statusText;
      throw new Error(`Telegram API sendDocument failed: ${message}`);
    }
  }

  async function sendPhoto(chatId, photo, options = {}) {
    logger.info("Sending Telegram photo", {
      chatId: String(chatId),
      fileName: options.fileName || options.filename || "qr.png",
      bytes: Buffer.isBuffer(photo) ? photo.length : undefined,
    });

    for (let attempt = 0; attempt <= 3; attempt++) {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append(
        "photo",
        new Blob([photo], {
          type: options.mimetype || "image/png",
        }),
        options.fileName || options.filename || "qr.png",
      );

      if (options.caption) {
        form.append("caption", options.caption);
      }
      if (options.parse_mode) {
        form.append("parse_mode", options.parse_mode);
      }

      const response = await fetch(
        buildTelegramUrl(config.bot_token, "sendPhoto"),
        {
          method: "POST",
          body: form,
        },
      );
      const body = await response.json();
      if (response.ok && body.ok) {
        return body.result;
      }

      const isRateLimit =
        response.status === 429 ||
        body.error_code === 429 ||
        /too many requests/i.test(body.description || "");

      if (isRateLimit && attempt < 3) {
        const retryAfterSec =
          body.parameters?.retry_after ||
          Number((body.description || "").match(/retry after (\d+)/i)?.[1]) ||
          3;
        const waitMs = (Math.min(retryAfterSec, 60) + 1) * 1000;
        logger.warn(
          `Telegram API sendPhoto rate-limited (429), retrying after ${waitMs}ms`,
          {
            attempt: attempt + 1,
            retryAfterSec,
            chatId,
          },
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      const message = body.description || response.statusText;
      throw new Error(`Telegram API sendPhoto failed: ${message}`);
    }
  }

  async function editMessageText(chatId, messageId, text, options = {}) {
    logger.info("Editing Telegram message", {
      chatId: String(chatId),
      messageId,
      length: String(text || "").length,
    });

    return callTelegramApi(config.bot_token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
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
      await handleUpdate(update, { downloadFile, sendDocument, sendMessage, sendPhoto, editMessageText });
    }
  }

  async function start() {
    if (!config.bot_token) {
      throw new Error("TELEGRAM_BOT_TOKEN belum diisi.");
    }

    logger.info("Starting Telegram polling bot");
    stopped = false;
    try {
      const dropPending = process.env.TELEGRAM_DROP_PENDING_UPDATES !== "false";
      await callTelegramApi(config.bot_token, "deleteWebhook", {
        drop_pending_updates: dropPending,
      });
      logger.info("Telegram webhook cleared on startup", { dropPending });
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
    editMessageText,
    sendDocument,
    sendPhoto,
    start,
    stop,
    downloadFile,
  };
}
