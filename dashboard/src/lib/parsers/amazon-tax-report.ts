/**
 * Parser for Amazon Custom Combined Tax reports (dashboard upload path).
 *
 * These reports have one row per order-line per jurisdiction level, with
 * ship_from_state / ship_to_state columns.  We deduplicate by
 * (order_id, asin) and aggregate sales by destination state + month.
 */

// ---------------------------------------------------------------------------
// Signature headers used for auto-detection
// ---------------------------------------------------------------------------

const SIGNATURE_HEADERS = new Set([
  "ship_from_state",
  "ship_to_state",
  "total_tax_collected_by_amazon",
]);

const HEADER_ALIASES: Record<string, string> = {
  "order id": "order_id",
  orderid: "order_id",
  order_date: "order_date",
  orderdate: "order_date",
  shipment_date: "shipment_date",
  shipmentdate: "shipment_date",
  "shipment date": "shipment_date",
  shipment_id: "shipment_id",
  shipmentid: "shipment_id",
  "shipment id": "shipment_id",
  asin: "asin",
  sku: "sku",
  quantity: "quantity",
  "ship from state": "ship_from_state",
  ship_from_state: "ship_from_state",
  shipfromstate: "ship_from_state",
  "ship from city": "ship_from_city",
  ship_from_city: "ship_from_city",
  shipfromcity: "ship_from_city",
  "ship to state": "ship_to_state",
  ship_to_state: "ship_to_state",
  shiptostate: "ship_to_state",
  "ship to city": "ship_to_city",
  ship_to_city: "ship_to_city",
  shiptocity: "ship_to_city",
  "ship to country": "ship_to_country",
  ship_to_country: "ship_to_country",
  shiptocountry: "ship_to_country",
  display_price: "display_price",
  "display price": "display_price",
  taxexclusive_selling_price: "taxexclusive_selling_price",
  "taxexclusive selling price": "taxexclusive_selling_price",
  tax_exclusive_selling_price: "taxexclusive_selling_price",
  total_tax: "total_tax",
  "total tax": "total_tax",
  totaltax: "total_tax",
  total_tax_collected_by_amazon: "total_tax_collected_by_amazon",
  "total tax collected by amazon": "total_tax_collected_by_amazon",
  tax_amount: "tax_amount",
  "tax amount": "tax_amount",
  taxable_amount: "taxable_amount",
  "taxable amount": "taxable_amount",
  jurisdiction_level: "jurisdiction_level",
  "jurisdiction level": "jurisdiction_level",
  transaction_type: "transaction_type",
  "transaction type": "transaction_type",
};

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeHeader(header: string): string {
  let h = header.trim().toLowerCase().replace(/^"|"$/g, "");
  h = h.replace(/[- ]/g, "_");
  // Strip parenthetical suffixes like "(UTC)"
  const parenIdx = h.indexOf("(");
  if (parenIdx !== -1) h = h.slice(0, parenIdx).trim().replace(/_$/, "");
  return HEADER_ALIASES[h] ?? h;
}

function parseDate(value: string): string | null {
  const v = value.trim().replace(/^"|"$/g, "");
  if (!v) return null;
  // "2023-12-22+00:00" -> take first 10 chars
  if (v.length >= 10) {
    const m = v.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  // MM/DD/YYYY
  const usMatch = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (usMatch) {
    const year = usMatch[3].length === 2 ? `20${usMatch[3]}` : usMatch[3];
    return `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  }
  return null;
}

function parseMoney(value: string): number {
  const v = value.trim().replace(/^"|"$/g, "").replace(/[$,]/g, "");
  if (!v) return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function monthStart(isoDate: string): string {
  return isoDate.slice(0, 7) + "-01";
}

function monthEnd(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  if (m === 12) return `${y}-12-31`;
  const d = new Date(y, m, 0); // day 0 of next month = last day of current
  return `${y}-${String(m).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ParsedSalesByState {
  state_code: string;
  channel: string;
  period_start: string;
  period_end: string;
  order_count: number;
  gross_sales: number;
  net_sales: number;
  tax_collected: number;
  source: string;
}

export interface ParsedShipFromEvent {
  source_file: string;
  event_date: string;
  fc_code: string;
  state_code: string;
  asin: string;
  quantity: number;
  event_type: string;
  raw_data: Record<string, unknown>;
}

export interface TaxReportParseResult {
  filename: string;
  rows_total: number;
  rows_parsed: number;
  rows_skipped: number;
  unique_orders: number;
  sales_records: ParsedSalesByState[];
  ship_from_events: ParsedShipFromEvent[];
  ship_to_states: string[];
  ship_from_states: string[];
  total_gross_sales: number;
  total_tax_collected: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the CSV header line indicates a Custom Combined Tax report.
 */
export function isCustomCombinedTax(firstLine: string): boolean {
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const headers = parseCSVLine(firstLine, delimiter).map(normalizeHeader);
  const headerSet = new Set(headers);
  for (const sig of SIGNATURE_HEADERS) {
    if (!headerSet.has(sig)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseAmazonTaxReportCSV(
  content: string,
  filename: string,
): TaxReportParseResult {
  const result: TaxReportParseResult = {
    filename,
    rows_total: 0,
    rows_parsed: 0,
    rows_skipped: 0,
    unique_orders: 0,
    sales_records: [],
    ship_from_events: [],
    ship_to_states: [],
    ship_from_states: [],
    total_gross_sales: 0,
    total_tax_collected: 0,
    warnings: [],
  };

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    result.warnings.push("File appears empty or has no data rows");
    return result;
  }

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const rawHeaders = parseCSVLine(lines[0], delimiter);
  const headerMap = rawHeaders.map(normalizeHeader);

  // Verify signature
  const headerSet = new Set(headerMap);
  for (const sig of SIGNATURE_HEADERS) {
    if (!headerSet.has(sig)) {
      result.warnings.push(`Missing required header: ${sig}`);
      return result;
    }
  }

  // Column indexes
  const col = (name: string) => headerMap.indexOf(name);
  const orderIdIdx = col("order_id");
  const asinIdx = col("asin");
  const shipToStateIdx = col("ship_to_state");
  const shipFromStateIdx = col("ship_from_state");
  const shipToCountryIdx = col("ship_to_country");
  const shipmentDateIdx = col("shipment_date");
  const orderDateIdx = col("order_date");
  const priceIdx = col("taxexclusive_selling_price");
  const displayPriceIdx = col("display_price");
  const taxCollectedIdx = col("total_tax_collected_by_amazon");
  const totalTaxIdx = col("total_tax");
  const qtyIdx = col("quantity");
  const shipFromCityIdx = col("ship_from_city");

  // Aggregation accumulators
  interface SalesBucket {
    orderIds: Set<string>;
    grossSales: number;
    taxCollected: number;
    quantity: number;
  }
  interface ShipFromBucket {
    quantity: number;
    cities: Set<string>;
  }

  const salesAgg = new Map<string, SalesBucket>();
  const shipFromAgg = new Map<string, ShipFromBucket>();
  const seenOrderLines = new Set<string>();
  const allOrderIds = new Set<string>();
  const shipToStates = new Set<string>();
  const shipFromStates = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    result.rows_total++;
    const fields = parseCSVLine(lines[i], delimiter);

    const orderId = (fields[orderIdIdx] ?? "").trim();
    const asin = (fields[asinIdx] ?? "").trim();
    const shipToState = (fields[shipToStateIdx] ?? "").trim().toUpperCase();
    const shipFromState = (fields[shipFromStateIdx] ?? "").trim().toUpperCase();
    const shipToCountry = shipToCountryIdx !== -1
      ? (fields[shipToCountryIdx] ?? "").trim().toUpperCase()
      : "";

    if (!orderId || !shipToState) {
      result.rows_skipped++;
      continue;
    }
    if (shipToCountry && shipToCountry !== "US") {
      result.rows_skipped++;
      continue;
    }
    if (!US_STATES.has(shipToState)) {
      result.rows_skipped++;
      continue;
    }

    result.rows_parsed++;
    allOrderIds.add(orderId);
    shipToStates.add(shipToState);
    if (shipFromState && US_STATES.has(shipFromState)) {
      shipFromStates.add(shipFromState);
    }

    // Deduplicate jurisdiction rows
    const dedupKey = `${orderId}\x00${asin}`;
    if (seenOrderLines.has(dedupKey)) continue;
    seenOrderLines.add(dedupKey);

    // Date
    const shipDateStr = shipmentDateIdx !== -1 ? (fields[shipmentDateIdx] ?? "") : "";
    const orderDateStr = orderDateIdx !== -1 ? (fields[orderDateIdx] ?? "") : "";
    const effectiveDate = parseDate(shipDateStr) ?? parseDate(orderDateStr);
    if (!effectiveDate) continue;

    const mStart = monthStart(effectiveDate);
    const mEnd = monthEnd(effectiveDate);

    // Amounts
    const rawPrice = priceIdx !== -1 ? (fields[priceIdx] ?? "") : "";
    const rawDisplay = displayPriceIdx !== -1 ? (fields[displayPriceIdx] ?? "") : "";
    const price = parseMoney(rawPrice || rawDisplay || "0");

    const rawTaxCol = taxCollectedIdx !== -1 ? (fields[taxCollectedIdx] ?? "") : "";
    const rawTotalTax = totalTaxIdx !== -1 ? (fields[totalTaxIdx] ?? "") : "";
    const tax = parseMoney(rawTaxCol || rawTotalTax || "0");

    let qty = 0;
    if (qtyIdx !== -1) {
      const parsed = parseInt((fields[qtyIdx] ?? "0").trim() || "0", 10);
      if (!isNaN(parsed)) qty = parsed;
    }
    const effectiveQty = Math.max(qty, 1);

    // Accumulate sales
    const salesKey = `${shipToState}\x00${mStart}`;
    let sBucket = salesAgg.get(salesKey);
    if (!sBucket) {
      sBucket = { orderIds: new Set(), grossSales: 0, taxCollected: 0, quantity: 0 };
      salesAgg.set(salesKey, sBucket);
    }
    sBucket.orderIds.add(orderId);
    sBucket.grossSales += price * effectiveQty;
    sBucket.taxCollected += tax;
    sBucket.quantity += effectiveQty;

    // Accumulate ship-from
    if (shipFromState && US_STATES.has(shipFromState)) {
      const sfKey = `${shipFromState}\x00${mStart}`;
      let sfBucket = shipFromAgg.get(sfKey);
      if (!sfBucket) {
        sfBucket = { quantity: 0, cities: new Set() };
        shipFromAgg.set(sfKey, sfBucket);
      }
      sfBucket.quantity += effectiveQty;
      if (shipFromCityIdx !== -1) {
        const city = (fields[shipFromCityIdx] ?? "").trim().toUpperCase();
        if (city) sfBucket.cities.add(city);
      }
    }
  }

  // Build sales records
  let totalGross = 0;
  let totalTax = 0;
  for (const [key, bucket] of salesAgg) {
    const [state, pStart] = key.split("\x00");
    const pEnd = monthEnd(pStart);
    const gross = Math.round(bucket.grossSales * 100) / 100;
    const taxCol = Math.round(bucket.taxCollected * 100) / 100;
    totalGross += gross;
    totalTax += taxCol;
    result.sales_records.push({
      state_code: state,
      channel: "amazon",
      period_start: pStart,
      period_end: pEnd,
      order_count: bucket.orderIds.size,
      gross_sales: gross,
      net_sales: gross,
      tax_collected: taxCol,
      source: "amazon_custom_combined_tax",
    });
  }

  // Build ship-from events
  for (const [key, bucket] of shipFromAgg) {
    const [state, pStart] = key.split("\x00");
    result.ship_from_events.push({
      source_file: filename,
      event_date: pStart,
      fc_code: `TAX-RPT-${state}`,
      state_code: state,
      asin: "ALL",
      quantity: bucket.quantity,
      event_type: "TaxReportShipFrom",
      raw_data: {
        cities: Array.from(bucket.cities).sort(),
        source: "amazon_custom_combined_tax",
      },
    });
  }

  result.unique_orders = allOrderIds.size;
  result.ship_to_states = Array.from(shipToStates).sort();
  result.ship_from_states = Array.from(shipFromStates).sort();
  result.total_gross_sales = Math.round(totalGross * 100) / 100;
  result.total_tax_collected = Math.round(totalTax * 100) / 100;

  return result;
}
