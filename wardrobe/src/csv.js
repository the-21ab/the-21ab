// Spreadsheet apps run cells that start with these characters as formulas, so text typed
// by a person gets a leading apostrophe (the usual "treat this as text" marker).
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value, guard) {
  if (value == null) return '';
  let text = String(value);
  if (guard && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns, rows, { userText = [] } = {}) {
  const guarded = new Set(userText);
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(row[c], guarded.has(c))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
