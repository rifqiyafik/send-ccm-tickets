import test from "node:test";
import assert from "node:assert/strict";

import {
  enqueueTicketMessage,
  cancelQueue,
  isQueueCancelled,
} from "../src/services/messageQueueService.js";
import {
  cancelActiveDelivery,
  isDeliveryCancelled,
} from "../src/handlers/whatsappMessageHandler.js";

test("cancelQueue stops queued execution and resets queue", async () => {
  let executedCount = 0;

  enqueueTicketMessage(async () => {
    executedCount += 1;
  }, { assignmentType: "SQA", orderId: "CC-1" });

  enqueueTicketMessage(async () => {
    executedCount += 1;
  }, { assignmentType: "SQA", orderId: "CC-2" });

  cancelQueue("Test cancel");
  assert.equal(isQueueCancelled(), true);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(isQueueCancelled(), false);
});

test("cancelActiveDelivery triggers queue and delivery cancellation", () => {
  const result = cancelActiveDelivery("Test active delivery cancel");
  assert.equal(result, true);
  assert.equal(isDeliveryCancelled(), true);
});
