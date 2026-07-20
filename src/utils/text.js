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
