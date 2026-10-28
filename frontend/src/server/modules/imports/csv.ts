/**
 * Hand-written CSV support for the import module (no external dependency).
 *
 * `decodeBytes`   utf-8 (BOM stripped) -> cp1252 -> latin-1, like the Python `_decode`
 * `sniffDelimiter` picks one of , ; tab | from a sample (Python `csv.Sniffer`, restricted to those delimiters)
 * `parseCsv`      RFC 4180 style reader: quoted fields, doubled quotes, embedded delimiters/newlines, CRLF/CR/LF rows
 */

// Bytes cp1252 leaves undefined; Python's cp1252 codec fails on them (and the decoder then falls back to latin-1).
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

export function decodeBytes(bytes: Uint8Array): string {
  try {
    // fatal: invalid UTF-8 throws; the default (ignoreBOM: false) drops a leading BOM like Python's utf-8-sig
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    /* not UTF-8 */
  }
  if (!bytes.some((b) => CP1252_UNDEFINED.has(b))) return new TextDecoder("windows-1252").decode(bytes);
  return Buffer.from(bytes).toString("latin1");
}

const DELIMITERS = [",", "\t", ";", "|"];

/** Counts of `delim` per record in the sample (quotes respected), for the first ~100 non-empty records. */
function delimiterCounts(sample: string, delim: string): number[] {
  const counts: number[] = [];
  let inQuotes = false;
  let n = 0;
  let seen = false;
  for (let i = 0; i < sample.length && counts.length < 100; i++) {
    const ch = sample[i];
    if (inQuotes) {
      if (ch === '"') {
        if (sample[i + 1] === '"') i++;
        else inQuotes = false;
      }
      seen = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      seen = true;
    } else if (ch === delim) {
      n++;
      seen = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && sample[i + 1] === "\n") i++;
      if (seen) counts.push(n);
      n = 0;
      seen = false;
    } else {
      seen = true;
    }
  }
  if (seen && counts.length < 100) counts.push(n);
  return counts;
}

export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 20_000);
  let best: { delim: string; consistency: number; mode: number } | null = null;
  for (const delim of DELIMITERS) {
    const counts = delimiterCounts(sample, delim);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    // modal non-zero count and how many records agree with it
    let mode = 0;
    let modeFreq = 0;
    for (const [c, f] of freq) if (c > 0 && f > modeFreq) [mode, modeFreq] = [c, f];
    if (!mode) continue;
    const consistency = modeFreq / counts.length;
    if (consistency < 0.9) continue;
    if (!best || consistency > best.consistency || (consistency === best.consistency && mode > best.mode)) {
      best = { delim, consistency, mode };
    }
  }
  return best ? best.delim : ",";
}

/** Parse CSV text into rows of cells. A leading BOM is ignored; fully blank lines yield `[]` like `csv.reader`. */
export function parseCsv(input: string, delimiter = ","): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false; // closing quote seen; remaining chars up to the delimiter are appended literally
  let started = false; // current record has any content (distinguishes a trailing newline from a blank record)

  const endField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
  };
  const endRow = () => {
    if (started || row.length) {
      endField();
      rows.push(row);
    } else {
      rows.push([]);
    }
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "" && !afterQuote) {
      inQuotes = true;
      started = true;
    } else if (ch === delimiter) {
      started = true;
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      started = true;
      field += ch;
    }
  }
  if (started || row.length || field) endRow();
  return rows;
}
