import { fcToState } from "./fc-codes";

const HEADER_ALIASES: Record<string, string> = {
  "date/time": "date-time",
  datetime: "date-time",
  "fulfillment-center": "fulfillment-center-id",
  "fulfillment center": "fulfillment-center-id",
  fc: "fulfillment-center-id",
  "event type": "event-type",
  eventtype: "event-type",
};

function normalizeHeader(header: string): string {
  const h = header.trim().toLowerCase();
  return HEADER_ALIASES[h] ?? h;
}

function parseDate(value: string): string | null {
  const v = value.trim();
  // Try ISO-like: 2024-01-15T10:30:00Z or 2024-01-15
  const isoMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // Try MM/DD/YYYY or MM/DD/YY
  const usMatch = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (usMatch) {
    const year =
      usMatch[3].length === 2 ? `20${usMatch[3]}` : usMatch[3];
    return `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  }
  return null;
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export interface ParsedEvent {
  source_file: string;
  event_date: string;
  fc_code: string;
  state_code: string | null;
  asin: string | null;
  sku: string | null;
  fnsku: string | null;
  quantity: number;
  event_type: string | null;
  disposition: string | null;
}

export interface ParseResult {
  filename: string;
  rows_total: number;
  rows_parsed: number;
  rows_skipped: number;
  events: ParsedEvent[];
  states_found: string[];
  unknown_fcs: string[];
  warnings: string[];
}

export function parseAmazonInventoryCSV(
  content: string,
  filename: string
): ParseResult {
  const result: ParseResult = {
    filename,
    rows_total: 0,
    rows_parsed: 0,
    rows_skipped: 0,
    events: [],
    states_found: [],
    unknown_fcs: [],
    warnings: [],
  };

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    result.warnings.push("File appears empty or has no data rows");
    return result;
  }

  // Detect delimiter
  const delimiter = lines[0].includes("\t") ? "\t" : ",";

  // Parse headers
  const rawHeaders = parseCSVLine(lines[0], delimiter);
  const headerMap = rawHeaders.map((h) => normalizeHeader(h));

  const fcIdx = headerMap.indexOf("fulfillment-center-id");
  const dateIdx = headerMap.indexOf("date-time");

  if (fcIdx === -1 || dateIdx === -1) {
    result.warnings.push(
      `Missing required headers. Found: [${headerMap.join(", ")}]. Need: fulfillment-center-id, date-time`
    );
    return result;
  }

  const asinIdx = headerMap.indexOf("asin");
  const skuIdx = headerMap.indexOf("sku");
  const fnskuIdx = headerMap.indexOf("fnsku");
  const qtyIdx = headerMap.indexOf("quantity");
  const eventTypeIdx = headerMap.indexOf("event-type");
  const dispIdx = headerMap.indexOf("disposition");

  const statesFound = new Set<string>();
  const unknownFcs = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    result.rows_total++;
    const fields = parseCSVLine(lines[i], delimiter);

    const fcCode = (fields[fcIdx] ?? "").trim().toUpperCase();
    const dateStr = fields[dateIdx] ?? "";

    if (!fcCode || !dateStr.trim()) {
      result.rows_skipped++;
      if (result.warnings.length < 20) {
        result.warnings.push(`Row ${i + 1}: missing FC code or date`);
      }
      continue;
    }

    const eventDate = parseDate(dateStr);
    if (!eventDate) {
      result.rows_skipped++;
      if (result.warnings.length < 20) {
        result.warnings.push(`Row ${i + 1}: unparseable date '${dateStr.trim()}'`);
      }
      continue;
    }

    const stateCode = fcToState(fcCode);
    if (stateCode === null) {
      unknownFcs.add(fcCode);
    } else {
      statesFound.add(stateCode);
    }

    let qty = 0;
    if (qtyIdx !== -1) {
      const raw = (fields[qtyIdx] ?? "0").trim();
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) qty = parsed;
    }

    result.events.push({
      source_file: filename,
      event_date: eventDate,
      fc_code: fcCode,
      state_code: stateCode,
      asin: asinIdx !== -1 ? (fields[asinIdx] ?? "").trim() || null : null,
      sku: skuIdx !== -1 ? (fields[skuIdx] ?? "").trim() || null : null,
      fnsku: fnskuIdx !== -1 ? (fields[fnskuIdx] ?? "").trim() || null : null,
      quantity: qty,
      event_type:
        eventTypeIdx !== -1
          ? (fields[eventTypeIdx] ?? "").trim() || null
          : null,
      disposition:
        dispIdx !== -1 ? (fields[dispIdx] ?? "").trim() || null : null,
    });
    result.rows_parsed++;
  }

  result.states_found = Array.from(statesFound).sort();
  result.unknown_fcs = Array.from(unknownFcs).sort();

  if (unknownFcs.size > 0) {
    result.warnings.push(
      `Unknown FC codes (not mapped to states): ${result.unknown_fcs.join(", ")}. Add them to config/fc_codes.json.`
    );
  }

  return result;
}
