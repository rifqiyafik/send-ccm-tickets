import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTelegramRichText,
  splitTelegramMessageText,
} from "../src/utils/telegramFormat.js";

test("formats fenced tables as Telegram pre blocks", () => {
  const result = formatTelegramRichText(
    [
      "**Report**",
      "",
      "```",
      "+----------+",
      "| Order ID |",
      "+----------+",
      "```",
    ].join("\n"),
  );

  assert.match(result, /<b>Report<\/b>/);
  assert.match(result, /<pre>\+----------\+/);
  assert.doesNotMatch(result, /<code>\+----------\+<\/code>/);
});

test("splits long Telegram messages into safe bubbles", () => {
  const chunks = splitTelegramMessageText(
    [
      "**Report**",
      "",
      "```",
      ...Array.from(
        { length: 40 },
        (_, index) => `| CC-${String(index).padStart(4, "0")} | LONG_REASON | CITY |`,
      ),
      "```",
    ].join("\n"),
    300,
  );

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 300, chunk);
    assert.equal((chunk.match(/```/g) || []).length % 2, 0, chunk);
  }
});
