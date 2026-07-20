import fs from "fs";

// membaca file JSON dan mengubahnya menjadi object/array JavaScript.
export function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

// membaca JSON array seperti database PIC/site dan validasi bentuk datanya.
export function readJsonArray(filePath, label = "JSON data") {
  const rows = readJsonFile(filePath);

  if (!Array.isArray(rows)) {
    throw new Error(`${label} must be an array`);
  }

  return rows;
}

// membaca JSON object seperti config WhatsApp dan validasi bentuk datanya.
export function readJsonObject(filePath, label = "JSON config") {
  const data = readJsonFile(filePath);

  if (!data || Array.isArray(data) || typeof data !== "object") {
    throw new Error(`${label} must be an object`);
  }

  return data;
}
