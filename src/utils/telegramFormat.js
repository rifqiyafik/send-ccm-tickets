const TELEGRAM_SAFE_MESSAGE_LIMIT = 3500;

// #penjelasan: escape HTML wajib sebelum mengirim parse_mode HTML ke Telegram agar karakter user/config tidak merusak pesan.
export function escapeTelegramHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramInlineRichText(value) {
  return escapeTelegramHtml(value)
    .replace(/^###\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

// #penjelasan: formatter ringan untuk style pesan Telegram; mendukung **bold**, `code`, heading markdown, dan ```table/code block```.
export function formatTelegramRichText(value) {
  const text = String(value || "");
  const parts = text.split(/```([\s\S]*?)```/g);

  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return `<pre>${escapeTelegramHtml(part.trim())}</pre>`;
      }
      return formatTelegramInlineRichText(part);
    })
    .join("");
}

// #penjelasan: helper payload standar agar semua handler bisa mengirim teks Telegram yang sudah diparse konsisten.
export function createTelegramRichMessage(text, options = {}) {
  return {
    text: formatTelegramRichText(text),
    options: {
      parse_mode: "HTML",
      ...options,
    },
  };
}

function pushChunk(chunks, value) {
  const text = String(value || "").trim();
  if (text) {
    chunks.push(text);
  }
}

function splitPlainTextPart(value, maxLength) {
  const chunks = [];
  let current = "";
  const lines = String(value || "").split("\n");

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    pushChunk(chunks, current);
    current = line;

    while (current.length > maxLength) {
      pushChunk(chunks, current.slice(0, maxLength));
      current = current.slice(maxLength);
    }
  }

  pushChunk(chunks, current);
  return chunks;
}

function splitCodeBlockPart(value, maxLength) {
  const chunks = [];
  const wrapperLength = "```\n\n```".length;
  const innerLimit = Math.max(1, maxLength - wrapperLength);
  let currentLines = [];
  let currentLength = 0;

  for (const line of String(value || "").trim().split("\n")) {
    const lineLength = line.length + (currentLines.length > 0 ? 1 : 0);
    if (currentLines.length > 0 && currentLength + lineLength > innerLimit) {
      pushChunk(chunks, ["```", ...currentLines, "```"].join("\n"));
      currentLines = [];
      currentLength = 0;
    }

    if (line.length > innerLimit) {
      pushChunk(chunks, ["```", line.slice(0, innerLimit), "```"].join("\n"));
      const restChunks = splitPlainTextPart(line.slice(innerLimit), innerLimit);
      chunks.push(...restChunks.map((chunk) => ["```", chunk, "```"].join("\n")));
      continue;
    }

    currentLines.push(line);
    currentLength += lineLength;
  }

  if (currentLines.length > 0) {
    pushChunk(chunks, ["```", ...currentLines, "```"].join("\n"));
  }

  return chunks;
}

// #penjelasan: memecah pesan panjang Telegram menjadi beberapa bubble aman tanpa merusak fenced table/code block.
export function splitTelegramMessageText(
  value,
  maxLength = TELEGRAM_SAFE_MESSAGE_LIMIT,
) {
  const chunks = [];
  const parts = String(value || "").split(/```([\s\S]*?)```/g);

  for (const [index, part] of parts.entries()) {
    const partChunks =
      index % 2 === 1
        ? splitCodeBlockPart(part, maxLength)
        : splitPlainTextPart(part, maxLength);

    for (const partChunk of partChunks) {
      const next = chunks.length > 0 ? `${chunks.at(-1)}\n\n${partChunk}` : partChunk;
      if (chunks.length > 0 && next.length <= maxLength) {
        chunks[chunks.length - 1] = next;
      } else {
        pushChunk(chunks, partChunk);
      }
    }
  }

  return chunks.length > 0 ? chunks : [""];
}
