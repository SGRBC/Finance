// Converts the office_read "data.txt" dump of the SGRBC Finance Cash Flow workbook into app/seed.json.
// Usage: node tools/build-seed.mjs <path-to-data.txt> [output.json]
import { readFileSync, writeFileSync } from "node:fs";

const [input, output = "app/seed.json"] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node tools/build-seed.mjs <data.txt> [output.json]");
  process.exit(1);
}

const lines = readFileSync(input, "utf8").split(/\r?\n/);
const transactions = [];
const categories = { Credit: [], Debit: [] };
let sheet = "";

for (const line of lines) {
  const sheetMatch = line.match(/^=== Sheet: (.+) ===$/);
  if (sheetMatch) {
    sheet = sheetMatch[1];
    continue;
  }
  const m = line.match(/^\[\/([^/]+)\/row\[(\d+)\]\] (.*)$/);
  if (!m) continue;
  const [, name, rowStr, rest] = m;
  const row = Number(rowStr);
  if (row === 1) continue; // header

  const cells = {};
  for (const cell of rest.split("\t")) {
    const i = cell.indexOf("=");
    if (i === -1) continue;
    cells[cell.slice(0, i).replace(/\d+$/, "")] = cell.slice(i + 1);
  }

  if (name === "Category") {
    if (categories[cells.A] && !categories[cells.A].includes(cells.B)) categories[cells.A].push(cells.B);
  } else if (name === "Main") {
    const amount = parseFloat(cells.D);
    const date = (cells.A || "").trim().replace(" ", "T").slice(0, 16);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date) || !Number.isFinite(amount)) {
      console.warn(`Skipping row ${row}: invalid date/amount`);
      continue;
    }
    transactions.push({
      id: `seed-${row}`,
      date,
      type: cells.B,
      category: cells.C,
      amount,
      description: (cells.E || "").trim(),
    });
  }
}

// Make sure every category used in data is also offered in the form.
for (const t of transactions) {
  if (categories[t.type] && !categories[t.type].includes(t.category)) categories[t.type].push(t.category);
}

transactions.sort((a, b) => b.date.localeCompare(a.date));
writeFileSync(output, JSON.stringify({ categories, transactions }));
console.log(`Wrote ${transactions.length} transactions to ${output}`);
console.log(JSON.stringify(categories));
