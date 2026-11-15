// menormalkan teks untuk key search agar tidak sensitif kapital dan spasi.
export function normalizeSearchKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export const normalizeLookupKey = normalizeSearchKey;

// membersihkan nilai satu baris agar aman dipakai di Excel/pesan.
export function cleanInlineText(value, fallback = "-") {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return text || fallback;
}

// membersihkan nilai tabel, termasuk mengganti pipe agar tidak merusak tampilan tabel.
export function cleanTableValue(value) {
  const text = cleanInlineText(value);
  return text === "-" ? text : text.replace(/\|/g, "/");
}

// merapikan teks panjang dari notes/analisis tanpa menghilangkan paragraf penting.
export function cleanMultilineText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// membuat teks tag manusiawi dari nama PIC; mention WA asli tetap perlu JID dari config.
export function formatNameTag(name, suffix = "") {
  const cleanName = cleanTableValue(name);
  if (cleanName === "-") {
    return "";
  }

  return `@Bg ${cleanName}${suffix ? ` ${suffix}` : ""}`;
}

// memeriksa apakah teks memiliki setidaknya satu huruf bermakna (bukan hanya spasi, simbol, atau karakter kosong)
export function hasMeaningfulLetters(text) {
  if (typeof text !== "string") return false;
  // Hapus semua whitespace dan invisible / zero-width characters
  const cleaned = text.replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, "");
  if (!cleaned) return false;
  // Pastikan memiliki huruf alfabetik (mendukung unicode dan ASCII)
  return /[a-zA-Z\p{L}]/u.test(cleaned);
}

// memvalidasi apakah payload pesan Baileys / WhatsApp memiliki konten valid (bukan pesan kosong)
export function isMeaningfulPayload(payload) {
  if (!payload) return false;

  if (typeof payload === "string") {
    return hasMeaningfulLetters(payload);
  }

  if (typeof payload !== "object") {
    return false;
  }

  // Jika payload adalah edit pesan:
  if (payload.edit) {
    return typeof payload.text === "string" && hasMeaningfulLetters(payload.text);
  }

  // Jika payload reaction emoji:
  if (payload.react && typeof payload.react.text === "string" && payload.react.text.trim()) {
    return true;
  }

  // Jika memiliki attachment dokumen / media:
  const media =
    payload.document ||
    payload.image ||
    payload.video ||
    payload.audio ||
    payload.sticker;

  if (media !== undefined && media !== null) {
    if (Buffer.isBuffer(media) && media.length === 0) {
      return false;
    }
    return true;
  }

  // Jika memiliki text:
  if (typeof payload.text === "string") {
    return hasMeaningfulLetters(payload.text);
  }

  return false;
}

