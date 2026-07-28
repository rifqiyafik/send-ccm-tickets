import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLogger } from "./logger.js";

const logger = createLogger("processLock");
const activeLocks = new Map();

// cek PID masih hidup agar lock lama dari proses crash tidak memblokir startup berikutnya.
function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// membaca isi lock lama untuk menentukan apakah proses pemiliknya masih aktif.
function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

// melepas lock berbasis direktori secara langsung (termasuk membongkar lock file di disk jika terpencil).
export function releaseProcessLockByDir(lockDir) {
  const lockPath = path.join(lockDir, ".process.lock");
  const release = activeLocks.get(lockPath);

  if (release) {
    release();
    return true;
  }

  try {
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { force: true });
      logger.info("Forced stale process lock removal", { lockPath });
      return true;
    }
  } catch (error) {
    logger.warn("Failed to force remove process lock file", {
      lockPath,
      error: error.message,
    });
  }

  return false;
}

// membuat lock eksklusif agar satu folder session Baileys hanya dipakai satu proses.
export function acquireProcessLock(lockDir, owner, options = {}) {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, ".process.lock");
  const existingLock = activeLocks.get(lockPath);

  if (existingLock) {
    return existingLock;
  }

  if (options.forceClean) {
    releaseProcessLockByDir(lockDir);
  }

  const lockData = {
    owner,
    app_name: "send-ccm-ticket",
    hostname: os.hostname(),
    pid: process.pid,
    started_at: new Date().toISOString(),
  };

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(lockData, null, 2)}\n`);
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }

    const currentLock = readLock(lockPath);
    const samePid = currentLock?.pid === process.pid;
    const sameHostname = !currentLock?.hostname || currentLock?.hostname === os.hostname();

    if (samePid || (sameHostname && !activeLocks.has(lockPath))) {
      logger.warn("Removing orphan/stale process lock for current process session switch", {
        lockPath,
        currentLock,
        pid: process.pid,
      });
      fs.rmSync(lockPath, { force: true });
      return acquireProcessLock(lockDir, owner, options);
    }

    if (isPidRunning(currentLock?.pid)) {
      const message = [
        `Session WhatsApp sedang dipakai proses lain (${currentLock.owner || "unknown"}, PID ${currentLock.pid}).`,
        "Tutup proses npm start/npm run jid yang masih berjalan, lalu jalankan ulang.",
      ].join(" ");
      throw new Error(message);
    }

    logger.warn("Removing stale process lock", { lockPath, currentLock });
    fs.rmSync(lockPath, { force: true });
    return acquireProcessLock(lockDir, owner, options);
  }

  let released = false;
  const release = () => {
    if (released) {
      return;
    }

    released = true;
    activeLocks.delete(lockPath);

    const currentLock = readLock(lockPath);
    if (currentLock?.pid === process.pid) {
      fs.rmSync(lockPath, { force: true });
      logger.info("Process lock released", { lockPath, owner });
    }
  };

  activeLocks.set(lockPath, release);
  logger.info("Process lock acquired", { lockPath, owner, pid: process.pid });

  return release;
}
