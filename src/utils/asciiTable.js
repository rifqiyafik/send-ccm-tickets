import { cleanTableValue } from "./text.js";

// #penjelasan: membungkus teks menjadi code block agar Telegram menampilkan tabel sebagai monospace/copy block.
export function createCodeBlock(lines) {
  return ["```", ...lines, "```"].join("\n");
}

function normalizeCell(value) {
  return cleanTableValue(value).replace(/\s+/g, " ");
}

function resolveColumnWidth(column, rows) {
  const values = [column.header, ...rows.map((row) => row[column.key])].map(
    normalizeCell,
  );
  const contentWidth = Math.max(...values.map((value) => value.length));
  const minWidth = column.width || column.minWidth || column.header.length;
  const maxWidth = column.maxWidth || Math.max(contentWidth, minWidth);

  return Math.min(Math.max(contentWidth, minWidth), maxWidth);
}

function fitCell(value, width) {
  const text = normalizeCell(value);
  if (text.length <= width) {
    return text.padEnd(width, " ");
  }

  if (width <= 3) {
    return text.slice(0, width);
  }

  return `${text.slice(0, width - 3)}...`;
}

function createBorder(widths) {
  return `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
}

function createRow(values, widths) {
  return `| ${values
    .map((value, index) => fitCell(value, widths[index]))
    .join(" | ")} |`;
}

// #penjelasan: membuat tabel ASCII dengan lebar kolom konsisten agar garis vertikal tidak bergeser.
export function formatAsciiTable(columns, rows) {
  const widths = columns.map((column) => resolveColumnWidth(column, rows));
  const border = createBorder(widths);
  const header = createRow(
    columns.map((column) => column.header),
    widths,
  );
  const body = rows.map((row) =>
    createRow(
      columns.map((column) => row[column.key]),
      widths,
    ),
  );

  return [border, header, border, ...body, border];
}
