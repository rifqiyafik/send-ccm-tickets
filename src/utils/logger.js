import { inspect } from "node:util";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const LEVEL_STYLE = {
  DEBUG: "\x1b[36m",
  INFO: "\x1b[32m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
};

// Filter output bising libsignal (dump cryptographic session/buffer internal Baileys)
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const NOISY_LIBSIGNAL_PATTERNS = [
  "Closing session:",
  "Opening session:",
  "Removing old closed session:",
  "Decrypted message with closed session.",
  "Session already closed",
  "Session already open",
  "Closing open session in favor of incoming prekey bundle",
  "Session error:Error: Bad MAC",
  "Failed to decrypt message with any known session",
  "Bad MAC",
];

function isNoisyLibsignalMessage(args) {
  const messageStr = args
    .map((arg) => (typeof arg === "string" ? arg : arg?.message || arg?.stack || ""))
    .join(" ");
  return NOISY_LIBSIGNAL_PATTERNS.some((pattern) => messageStr.includes(pattern));
}

console.info = (...args) => {
  if (isNoisyLibsignalMessage(args)) return;
  originalConsoleInfo(...args);
};

console.warn = (...args) => {
  if (isNoisyLibsignalMessage(args)) return;
  originalConsoleWarn(...args);
};

console.log = (...args) => {
  if (isNoisyLibsignalMessage(args)) return;
  originalConsoleLog(...args);
};

console.error = (...args) => {
  if (isNoisyLibsignalMessage(args)) return;
  originalConsoleError(...args);
};

function timestamp() {
  const date = new Date();
  const tzOffsetMs = date.getTimezoneOffset() * 60000;
  const localDate = new Date(date.getTime() - tzOffsetMs);
  const iso = localDate.toISOString().replace("Z", "");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offsetStr = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  return `${iso}${offsetStr}`;
}

function shouldUseColor() {
  return process.env.NO_COLOR !== "true" && process.env.LOG_COLOR !== "false";
}

function activeLevel() {
  const value = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[value] ?? LEVELS.info;
}

function shouldWrite(level) {
  if (level === "DEBUG" && process.env.APP_DEBUG === "true") {
    return true;
  }

  return LEVELS[level.toLowerCase()] >= activeLevel();
}

function colorize(value, color) {
  if (!shouldUseColor()) {
    return value;
  }

  return `${color}${value}${RESET}`;
}

function formatPrefix(level, scope, message) {
  const levelLabel = colorize(level.padEnd(5), `${BOLD}${LEVEL_STYLE[level] || ""}`);
  const timeLabel = colorize(timestamp(), DIM);
  const scopeLabel = colorize(scope, "\x1b[35m");

  return `${timeLabel} | ${levelLabel} | ${scopeLabel} | ${message}`;
}

function formatMeta(meta) {
  if (typeof meta === "string") {
    return meta;
  }

  return inspect(meta, {
    colors: shouldUseColor(),
    depth: 8,
    breakLength: 120,
    compact: false,
  });
}

function write(level, scope, message, meta) {
  if (!shouldWrite(level)) {
    return;
  }

  const prefix = formatPrefix(level, scope, message);

  if (meta === undefined) {
    console.log(prefix);
    return;
  }

  console.log(`${prefix}\n${formatMeta(meta)}`);
}

export function createLogger(scope) {
  return {
    debug(message, meta) {
      if (process.env.APP_DEBUG === "true") {
        write("DEBUG", scope, message, meta);
      }
    },
    info(message, meta) {
      write("INFO", scope, message, meta);
    },
    warn(message, meta) {
      write("WARN", scope, message, meta);
    },
    error(message, error) {
      const meta =
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
            }
          : error;

      write("ERROR", scope, message, meta);
    },
  };
}
