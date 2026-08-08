import { normalizeSearchKey } from "./text.js";

/**
 * Extracts a Sumbagut city from description text (e.g., Lokasi Pelanggan (alamat) : ...).
 * @param {string} descriptionText
 * @param {Array<{city: string, departement_ns: string}>} ccmRows
 * @returns {string|null}
 */
export function extractCityFromDescription(descriptionText, ccmRows = []) {
  if (!descriptionText || typeof descriptionText !== "string") {
    return null;
  }

  const normalizedText = normalizeSearchKey(descriptionText);
  if (!normalizedText) {
    return null;
  }

  // Extract address section if "Lokasi Pelanggan" line is present
  const locationMatch = descriptionText.match(
    /lokasi\s+pelanggan\s*\([^)]*\)\s*:\s*([^\r\n]+)/i,
  );
  const searchSection = locationMatch
    ? normalizeSearchKey(locationMatch[1])
    : normalizedText;

  // Find matching city from ccmRows (prioritize longer city names first)
  const sortedRows = [...ccmRows]
    .filter((row) => row && row.city)
    .sort((a, b) => String(b.city || "").length - String(a.city || "").length);

  for (const row of sortedRows) {
    const cityKey = normalizeSearchKey(row.city);
    if (cityKey && searchSection.includes(cityKey)) {
      return row.city;
    }
  }

  return null;
}
