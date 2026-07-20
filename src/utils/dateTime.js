// mengubah nilai waktu dari Excel/string menjadi Date yang valid.
export function parseDateTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// menambah jam pada Date tanpa mengubah object asal.
export function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
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

  const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const months = [
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
