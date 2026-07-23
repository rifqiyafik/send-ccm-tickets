import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { acquireProcessLock } from "../src/utils/processLock.js";

function setupLockDir(name) {
  const lockDir = path.join("tmp", name);
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir, { recursive: true });

  return {
    lockDir,
    lockPath: path.join(lockDir, ".process.lock"),
    cleanup() {
      fs.rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

test("removes orphan lock file that has current process PID but is not registered in memory", () => {
  const context = setupLockDir("orphan-current-pid-lock");
  fs.writeFileSync(
    context.lockPath,
    `${JSON.stringify(
      {
        owner: "whatsapp-bot",
        pid: process.pid,
        started_at: new Date(Date.now() - 60_000).toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const release = acquireProcessLock(context.lockDir, "whatsapp-bot");
  const lock = JSON.parse(fs.readFileSync(context.lockPath, "utf8"));

  assert.equal(lock.pid, process.pid);
  assert.equal(lock.owner, "whatsapp-bot");

  release();
  assert.equal(fs.existsSync(context.lockPath), false);

  context.cleanup();
});
