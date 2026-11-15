export function parseDateTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (value === null || value === undefined) {
    return null;
  }

  // 1. Cek apakah Excel serial number (misal 45800.4305 atau "45800.4305")
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (Number.isFinite(num) && num > 1000 && num < 100000) {
    const utcDays = num - 25569;
    const ms = Math.round(utcDays * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  // 2. Format DD/MM/YYYY atau DD-MM-YYYY (format umum Indonesia/Excel)
  // Contoh: 23/05/2025 10:20:00 atau 23-05-2025 10:20
  const dmyMatch = text.match(
    /^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const hour = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 0;
    const minute = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
    const second = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;
    const d = new Date(year, month, day, hour, minute, second);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }

  // 3. Format YYYY-MM-DD atau YYYY/MM/DD
  // Contoh: 2025-05-23 10:20:00 atau 2025/05/23
  const ymdMatch = text.match(
    /^(\d{4})[\/\.-](\d{1,2})[\/\.-](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    const hour = ymdMatch[4] ? parseInt(ymdMatch[4], 10) : 0;
    const minute = ymdMatch[5] ? parseInt(ymdMatch[5], 10) : 0;
    const second = ymdMatch[6] ? parseInt(ymdMatch[6], 10) : 0;
    const d = new Date(year, month, day, hour, minute, second);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }

  // 4. Standar ISO Date / fallback
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// menambah jam pada Date tanpa mengubah object asal.
export function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export const INDONESIAN_DAYS = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];

export const INDONESIAN_MONTHS_FULL = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

export const INDONESIAN_MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

export const INDONESIAN_MONTHS_MAP = Object.fromEntries(
  INDONESIAN_MONTHS_FULL.map((name, idx) => [
    String(idx + 1).padStart(2, "0"),
    name,
  ]),
);

// memformat tanggal dalam bahasa Indonesia, contoh: Kamis 8 Oktober 2026.
export function formatIndonesianDate(value, options = {}) {
  const date = value instanceof Date ? value : parseDateTime(value);
  if (!date) return "-";

  const dayName = INDONESIAN_DAYS[date.getDay()];
  const dayNum = date.getDate();
  const monthName = options.shortMonth
    ? INDONESIAN_MONTHS_SHORT[date.getMonth()]
    : INDONESIAN_MONTHS_FULL[date.getMonth()];
  const year = date.getFullYear();

  if (options.includeDay === false) {
    return `${dayNum} ${monthName} ${year}`;
  }

  return `${dayName} ${dayNum} ${monthName} ${year}`;
}

// memformat target SLA untuk pesan WhatsApp, contoh: Kamis / 16 Jul 2026, 08:15:19 PM.
export function formatResolveTarget(value) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : parseDateTime(value);
  if (!date) {
    return "-";
  }

  const days = INDONESIAN_DAYS;
  const months = INDONESIAN_MONTHS_SHORT;
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 || 12;
  const ampm = hours24 >= 12 ? "PM" : "AM";
  const pad = (number) => String(number).padStart(2, "0");

  return `${days[date.getDay()]} / ${pad(date.getDate())} ${
    months[date.getMonth()]
  } ${date.getFullYear()}, ${pad(hours12)}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )} ${ampm}`;
}

// memformat tanggal untuk file Excel balasan agar konsisten dan mudah dibaca.
export function formatDateTimeValue(value, fallback = "-") {
  const date = value instanceof Date ? value : parseDateTime(value);
  if (!date) {
    return fallback;
  }

  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// mendapatkan tanggal hari ini dalam zona waktu WIB (UTC+7) format YYYY-MM-DD
// single source of truth; digunakan oleh inapTicketStore, ticketPollingService, dan sentTicketService.
export function getWibDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
