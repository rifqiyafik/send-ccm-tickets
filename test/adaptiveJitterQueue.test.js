import test from "node:test";
import assert from "node:assert/strict";

import {
  getQueueConfig,
  getPostSendDelay,
  executeWithRetry,
  cancelQueue,
} from "../src/services/messageQueueService.js";

test("getQueueConfig respects WA_SEND_DELAY_MIN_MS and WA_SEND_DELAY_MAX_MS from env", () => {
  const prevMin = process.env.WA_SEND_DELAY_MIN_MS;
  const prevMax = process.env.WA_SEND_DELAY_MAX_MS;
  const prevFixed = process.env.WA_SEND_DELAY_MS;

  try {
    process.env.WA_SEND_DELAY_MIN_MS = "5000";
    process.env.WA_SEND_DELAY_MAX_MS = "9000";
    delete process.env.WA_SEND_DELAY_MS;

    const config = getQueueConfig();
    assert.equal(config.minDelayMs, 5000);
    assert.equal(config.maxDelayMs, 9000);

    // Test calculation is within bounds
    for (let i = 0; i < 50; i++) {
      const delay = getPostSendDelay("TEST_NOP");
      // Could have batch extra delay or just jitter
      assert.ok(delay >= 5000, `Delay ${delay} must be >= 5000`);
      assert.ok(delay <= 9000 + 5000, `Delay ${delay} must be <= 14000`);
    }
  } finally {
    if (prevMin !== undefined) process.env.WA_SEND_DELAY_MIN_MS = prevMin;
    else delete process.env.WA_SEND_DELAY_MIN_MS;
    if (prevMax !== undefined) process.env.WA_SEND_DELAY_MAX_MS = prevMax;
    else delete process.env.WA_SEND_DELAY_MAX_MS;
    if (prevFixed !== undefined) process.env.WA_SEND_DELAY_MS = prevFixed;
    else delete process.env.WA_SEND_DELAY_MS;
  }
});

test("getQueueConfig falls back to WA_SEND_DELAY_MS if min/max not provided", () => {
  const prevMin = process.env.WA_SEND_DELAY_MIN_MS;
  const prevMax = process.env.WA_SEND_DELAY_MAX_MS;
  const prevFixed = process.env.WA_SEND_DELAY_MS;

  try {
    delete process.env.WA_SEND_DELAY_MIN_MS;
    delete process.env.WA_SEND_DELAY_MAX_MS;
    process.env.WA_SEND_DELAY_MS = "7500";

    const config = getQueueConfig();
    assert.equal(config.minDelayMs, 7500);
    assert.equal(config.maxDelayMs, 7500);

    const delay = getPostSendDelay("FALLBACK_TEST");
    assert.equal(delay, 7500);
  } finally {
    if (prevMin !== undefined) process.env.WA_SEND_DELAY_MIN_MS = prevMin;
    else delete process.env.WA_SEND_DELAY_MIN_MS;
    if (prevMax !== undefined) process.env.WA_SEND_DELAY_MAX_MS = prevMax;
    else delete process.env.WA_SEND_DELAY_MAX_MS;
    if (prevFixed !== undefined) process.env.WA_SEND_DELAY_MS = prevFixed;
    else delete process.env.WA_SEND_DELAY_MS;
  }
});

test("executeWithRetry retries on transient errors and succeeds when sendFn passes", async () => {
  const prevRetries = process.env.WA_RETRY_MAX_ATTEMPTS;
  const prevBackoff = process.env.WA_RETRY_BACKOFF_MS;

  try {
    process.env.WA_RETRY_MAX_ATTEMPTS = "3";
    process.env.WA_RETRY_BACKOFF_MS = "50"; // Fast for testing

    let attempts = 0;
    const sendFn = async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("Socket temporary disconnected");
      }
      return "sent_ok";
    };

    const result = await executeWithRetry(sendFn, { orderId: "TEST-01" });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
  } finally {
    if (prevRetries !== undefined) process.env.WA_RETRY_MAX_ATTEMPTS = prevRetries;
    else delete process.env.WA_RETRY_MAX_ATTEMPTS;
    if (prevBackoff !== undefined) process.env.WA_RETRY_BACKOFF_MS = prevBackoff;
    else delete process.env.WA_RETRY_BACKOFF_MS;
  }
});

test("executeWithRetry exhausts retries and returns ok: false gracefully without crashing", async () => {
  const prevRetries = process.env.WA_RETRY_MAX_ATTEMPTS;
  const prevBackoff = process.env.WA_RETRY_BACKOFF_MS;

  try {
    process.env.WA_RETRY_MAX_ATTEMPTS = "2";
    process.env.WA_RETRY_BACKOFF_MS = "50";

    let attempts = 0;
    const sendFn = async () => {
      attempts++;
      throw new Error("Persistent socket error");
    };

    const result = await executeWithRetry(sendFn, { orderId: "TEST-FAIL" });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
    assert.equal(result.error.message, "Persistent socket error");
  } finally {
    if (prevRetries !== undefined) process.env.WA_RETRY_MAX_ATTEMPTS = prevRetries;
    else delete process.env.WA_RETRY_MAX_ATTEMPTS;
    if (prevBackoff !== undefined) process.env.WA_RETRY_BACKOFF_MS = prevBackoff;
    else delete process.env.WA_RETRY_BACKOFF_MS;
  }
});
