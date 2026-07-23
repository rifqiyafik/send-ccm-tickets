import fs from "node:fs";
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

// membuat lock eksklusif agar satu folder session Baileys hanya dipakai satu proses.
export function acquireProcessLock(lockDir, owner) {
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, ".process.lock");
  const existingLock = activeLocks.get(lockPath);

  if (existingLock) {
    return existingLock;
  }

  const lockData = {
    owner,
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
    if (currentLock?.pid === process.pid) {
      logger.warn("Removing orphan process lock for current PID", {
        lockPath,
        currentLock,
        pid: process.pid,
      });
      fs.unlinkSync(lockPath);
      return acquireProcessLock(lockDir, owner);
    }

    if (isPidRunning(currentLock?.pid)) {
      const message = [
        `Session WhatsApp sedang dipakai proses lain (${currentLock.owner || "unknown"}, PID ${currentLock.pid}).`,
        "Tutup proses npm start/npm run jid yang masih berjalan, lalu jalankan ulang.",
      ].join(" ");
      throw new Error(message);
    }

    logger.warn("Removing stale process lock", { lockPath, currentLock });
    fs.unlinkSync(lockPath);
    return acquireProcessLock(lockDir, owner);
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
