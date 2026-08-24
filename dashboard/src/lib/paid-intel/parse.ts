import {
  audienceOf, campaignTypeOf, isBrandCampaign, productOf,
} from "./classify";
import {
  col, headerIndex, isTotalLabel, normHeader, parseCsv, parseDate,
  parseMoney, parsePct, round2, unzipCsvs,
} from "./csv";
import type {
  AcceptedFile, CampaignDaily, CampaignType, GaDaily, ParsedFiles, SearchQueryDaily,
} from "./types";

export type FileKind =
  | "google"
  | "meta"
  | "gsc_queries"
  | "gsc_pages"
  | "gsc_chart"
  | "ga4"
  | "gsc_zip"
  | "unknown";

const TYPE_PREFIX: { prefix: string; type: CampaignType }[] = [
  { prefix: "search_", type: "Search" },
  { prefix: "shopping_", type: "Shopping" },
  { prefix: "performance max_", type: "PMax" },
  { prefix: "pmax_", type: "PMax" },
];

export function detectKind(name: string, text: string): FileKind {
  const n = name.toLowerCase();
  if (n.endsWith(".zip")) return "gsc_zip";
  const head = text.slice(0, 2500);
  const lines = head.split(/\r?\n/).slice(0, 12);
  if (lines.some((l) => l.startsWith("#")) && /session default channel group/i.test(head)) {
    return "ga4";
  }
  if (/top queries/i.test(head) && /impressions/i.test(head) && /position/i.test(head)) {
    return "gsc_queries";
  }
  if (/top pages/i.test(head) && /impressions/i.test(head)) return "gsc_pages";
  if (/^date,clicks,impressions,ctr,position/im.test(head) && !/campaign/i.test(head)) {
    return "gsc_chart";
  }
  if (/amount spent \(usd\)/i.test(head) && /campaign name/i.test(head)) return "meta";
  if (/purchases conversion value/i.test(head) && /reporting starts/i.test(head)) return "meta";
  if (/google ads/i.test(head) && /campaign/i.test(head)) return "google";
  if (/search_cost|performance max_cost|search_clicks/i.test(head)) return "google";
  if (/\bcampaign\b/i.test(head) && (/\bcost\b/i.test(head) || /\bconv\.? value\b/i.test(head))
    && /\bday\b|\bdate\b/i.test(head)) {
    return "google";
  }
  if (n.includes("google")) return "google";
  if (n.includes("meta") || n.includes("tallow") && n.includes("campaign")) return "meta";
  if (n.includes("queries")) return "gsc_queries";
  if (n.includes("pages")) return "gsc_pages";
  if (n.includes("chart")) return "gsc_chart";
  if (n.includes("download") || n.includes("ga4") || n.includes("explore")) return "ga4";
  return "unknown";
}

function findHeaderRow(rows: string[][], pred: (h: string[]) => boolean): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    if (pred(rows[i].map(normHeader))) return i;
  }
  return -1;
}

function pickTypeMetrics(headers: string[], row: string[]) {
  const byType: Record<CampaignType, {
    clicks: number; conv_value: number; impressions: number;
    conversions: number; spend: number; lost_budget: number | null; lost_rank: number | null;
  }> = {
    Search: emptyType(), Shopping: emptyType(), PMax: emptyType(),
    DemandGen: emptyType(), Other: emptyType(),
  };
  headers.forEach((h, i) => {
    const nh = normHeader(h);
    for (const { prefix, type } of TYPE_PREFIX) {
      if (!nh.startsWith(prefix)) continue;
      const suffix = nh.slice(prefix.length);
      const cell = row[i];
      if (suffix === "clicks") byType[type].clicks += parseMoney(cell);
      else if (suffix === "conv value" || suffix === "conv. value") byType[type].conv_value += parseMoney(cell);
      else if (suffix === "impr" || suffix === "impressions") byType[type].impressions += parseMoney(cell);
      else if (suffix === "conversions") byType[type].conversions += parseMoney(cell);
      else if (suffix === "cost") byType[type].spend += parseMoney(cell);
      else if (suffix.includes("lost is (budget)") || suffix.includes("lost is budget")) {
        byType[type].lost_budget = parsePct(cell);
      } else if (suffix.includes("lost is (rank)") || suffix.includes("lost is rank")) {
        byType[type].lost_rank = parsePct(cell);
      }
    }
  });
  return byType;
}

function emptyType() {
  return {
    clicks: 0, conv_value: 0, impressions: 0, conversions: 0, spend: 0,
    lost_budget: null as number | null, lost_rank: null as number | null,
  };
}

function dominantType(byType: ReturnType<typeof pickTypeMetrics>): CampaignType {
  let best: CampaignType = "Other";
  let score = -1;
  for (const t of ["Search", "Shopping", "PMax"] as CampaignType[]) {
    const m = byType[t];
    const s = m.spend * 1000 + m.impressions + m.clicks;
    if (s > score) {
      score = s;
      best = t;
    }
  }
  return score > 0 ? best : "Other";
}

export function parseGoogleCsv(text: string): CampaignDaily[] {
  const rows = parseCsv(text);
  const hi = findHeaderRow(rows, (h) => h.includes("campaign") && (
    h.some((x) => x.includes("cost") || x.includes("search_cost") || x === "day")
  ));
  if (hi < 0) return [];
  const headers = rows[hi];
  const idx = headerIndex(headers);
  const hasTyped = headers.some((h) => /search_cost|performance max_cost|shopping_cost/i.test(h));
  const out: CampaignDaily[] = [];

  for (const row of rows.slice(hi + 1)) {
    const name = col(idx, row, "campaign", "campaign name").trim();
    if (!name || isTotalLabel(name) || isTotalLabel(row[0])) continue;
    const date = parseDate(col(idx, row, "day", "date"));
    if (!date) continue;

    let spend = 0, conv_value = 0, clicks = 0, impressions = 0, conversions = 0;
    let lost_is_budget: number | null = null;
    let lost_is_rank: number | null = null;
    let type: CampaignType = campaignTypeOf(name, col(idx, row, "campaign type", "type", "campaign type"));

    if (hasTyped) {
      const by = pickTypeMetrics(headers, row);
      const dom = dominantType(by);
      if (dom !== "Other") type = dom;
      for (const t of ["Search", "Shopping", "PMax"] as CampaignType[]) {
        const m = by[t];
        spend += m.spend;
        conv_value += m.conv_value;
        clicks += m.clicks;
        impressions += m.impressions;
        conversions += m.conversions;
        if (m.lost_budget != null) {
          lost_is_budget = lost_is_budget == null ? m.lost_budget : Math.max(lost_is_budget, m.lost_budget);
        }
        if (m.lost_rank != null) {
          lost_is_rank = lost_is_rank == null ? m.lost_rank : Math.max(lost_is_rank, m.lost_rank);
        }
      }
    } else {
      spend = parseMoney(col(idx, row, "cost", "cost (usd)", "spend"));
      conv_value = parseMoney(col(idx, row, "conv value", "conv. value", "conversion value", "conversions value"));
      clicks = parseMoney(col(idx, row, "clicks"));
      impressions = parseMoney(col(idx, row, "impr", "impressions", "impr."));
      conversions = parseMoney(col(idx, row, "conversions", "conv"));
      lost_is_budget = parsePct(col(idx, row, "search lost is (budget)", "search lost is budget"));
      lost_is_rank = parsePct(col(idx, row, "search lost is (rank)", "search lost is rank"));
    }

    out.push({
      platform: "google",
      date,
      campaign_name: name,
      campaign_type: type === "Other" ? campaignTypeOf(name) : type,
      product: productOf(name),
      is_brand: isBrandCampaign(name),
      audience: "unknown",
      spend: round2(spend),
      conv_value: round2(conv_value),
      clicks,
      impressions,
      conversions: round2(conversions),
      lost_is_budget,
      lost_is_rank,
      frequency: null,
      frequency_peak: null,
      status: col(idx, row, "campaign status", "status") || null,
    });
  }
  return out;
}

/**
 * Meta export → campaign-days.
 *
 * An ad-set (or ad) level export carries several rows per campaign per day.
 * Those MUST be summed, not last-wins: the warehouse key is
 * platform|date|campaign_name, so keeping one row would silently drop the
 * rest of the campaign's spend. Ad-set frequency is also kept as a peak,
 * because a campaign-weighted average hides one burnt-out ad set.
 */
export function parseMetaCsv(text: string): CampaignDaily[] {
  const rows = parseCsv(text);
  const hi = findHeaderRow(rows, (h) => h.includes("campaign name") || (
    h.includes("campaign") && h.some((x) => x.includes("amount spent"))
  ));
  if (hi < 0) return [];
  const headers = rows[hi];
  const idx = headerIndex(headers);
  const normalized = headers.map(normHeader);
  const subCampaign = normalized.some((h) => h === "ad set name" || h === "ad name");

  const acc = new Map<string, CampaignDaily & { _freqNum: number; _freqDen: number }>();
  for (const row of rows.slice(hi + 1)) {
    const name = col(idx, row, "campaign name", "campaign").trim();
    if (!name || isTotalLabel(name)) continue;
    const date = parseDate(col(idx, row, "reporting starts", "day", "date"));
    if (!date) continue;
    // Never treat CPC / cost-per-purchase as spend or revenue.
    const spend = parseMoney(col(idx, row, "amount spent (usd)", "amount spent"));
    const impressions = parseMoney(col(idx, row, "impressions"));
    if (spend === 0 && impressions === 0) continue;
    const conv_value = parseMoney(col(idx, row,
      "purchases conversion value", "purchase conversion value",
      "website purchases conversion value"));
    const conversions = parseMoney(col(idx, row, "purchases", "website purchases"));
    const clicks = parseMoney(col(idx, row, "link clicks", "clicks"));
    const frequency = parseMoney(col(idx, row, "frequency"));
    const status = col(idx, row, "campaign delivery", "delivery") || null;

    const key = `${date}|${name}`;
    const prev = acc.get(key);
    if (!prev) {
      acc.set(key, {
        platform: "meta",
        date,
        campaign_name: name,
        campaign_type: "Other",
        product: productOf(name),
        is_brand: isBrandCampaign(name),
        audience: audienceOf(name, "meta"),
        spend: spend,
        conv_value: conv_value,
        clicks,
        impressions,
        conversions,
        lost_is_budget: null,
        lost_is_rank: null,
        frequency: frequency > 0 ? frequency : null,
        frequency_peak: subCampaign && frequency > 0 ? frequency : null,
        status,
        _freqNum: frequency > 0 ? frequency * impressions : 0,
        _freqDen: frequency > 0 ? impressions : 0,
      });
      continue;
    }
    prev.spend += spend;
    prev.conv_value += conv_value;
    prev.clicks += clicks;
    prev.impressions += impressions;
    prev.conversions += conversions;
    if (frequency > 0) {
      prev._freqNum += frequency * impressions;
      prev._freqDen += impressions;
      prev.frequency_peak = Math.max(prev.frequency_peak ?? 0, frequency);
    }
    if (status) prev.status = status;
    // Sub-campaign rows share a product/audience; keep the campaign's own read.
  }

  return [...acc.values()].map((r) => {
    const { _freqNum, _freqDen, ...rest } = r;
    return {
      ...rest,
      spend: round2(rest.spend),
      conv_value: round2(rest.conv_value),
      conversions: round2(rest.conversions),
      frequency: _freqDen > 0 ? _freqNum / _freqDen : rest.frequency,
      frequency_peak: rest.frequency_peak,
    };
  });
}

function parseGscTable(text: string, kind: "query" | "page", nameCol: string): SearchQueryDaily[] {
  const rows = parseCsv(text);
  const hi = findHeaderRow(rows, (h) => h.includes(normHeader(nameCol)) && h.includes("impressions"));
  if (hi < 0) return [];
  const idx = headerIndex(rows[hi]);
  const out: SearchQueryDaily[] = [];
  for (const row of rows.slice(hi + 1)) {
    const query = col(idx, row, nameCol).trim();
    if (!query || isTotalLabel(query)) continue;
    const clicks = parseMoney(col(idx, row, "clicks"));
    const impressions = parseMoney(col(idx, row, "impressions"));
    const ctr = parsePct(col(idx, row, "ctr"));
    const position = parseMoney(col(idx, row, "position"));
    out.push({
      kind,
      date: "",
      query,
      clicks,
      impressions,
      ctr,
      position: position > 0 ? position : null,
    });
  }
  return out;
}

export function parseGscQueries(text: string): SearchQueryDaily[] {
  return parseGscTable(text, "query", "top queries");
}

export function parseGscPages(text: string): SearchQueryDaily[] {
  return parseGscTable(text, "page", "top pages");
}

export function parseGscChart(text: string): SearchQueryDaily[] {
  const rows = parseCsv(text);
  const hi = findHeaderRow(rows, (h) => h[0] === "date" && h.includes("clicks") && h.includes("position"));
  if (hi < 0) return [];
  const idx = headerIndex(rows[hi]);
  const out: SearchQueryDaily[] = [];
  for (const row of rows.slice(hi + 1)) {
    const date = parseDate(col(idx, row, "date"));
    if (!date) continue;
    out.push({
      kind: "chart",
      date,
      query: "(site)",
      clicks: parseMoney(col(idx, row, "clicks")),
      impressions: parseMoney(col(idx, row, "impressions")),
      ctr: parsePct(col(idx, row, "ctr")),
      position: parseMoney(col(idx, row, "position")) || null,
    });
  }
  return out;
}

export function parseGa4Csv(text: string): GaDaily[] {
  const cleaned = text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#") && !/grand total/i.test(l))
    .join("\n");
  const rows = parseCsv(cleaned);
  const hi = findHeaderRow(rows, (h) =>
    h.some((x) => x.includes("session default channel")) && h.some((x) => x.includes("landing")));
  if (hi < 0) return [];
  const idx = headerIndex(rows[hi]);
  const out: GaDaily[] = [];
  for (const row of rows.slice(hi + 1)) {
    if (row.some((c) => isTotalLabel(c))) continue;
    const date = parseDate(col(idx, row, "date"));
    if (!date) continue;
    const bounceRaw = col(idx, row, "bounce rate");
    out.push({
      date,
      channel_group: col(idx, row, "session default channel group", "default channel group", "session primary channel group") || "(not set)",
      landing_page: col(idx, row, "landing page", "landing page + query string") || "/",
      device: (col(idx, row, "device category", "device") || "unknown").toLowerCase(),
      sessions: parseMoney(col(idx, row, "sessions")),
      active_users: parseMoney(col(idx, row, "active users")),
      key_events: parseMoney(col(idx, row, "key events")),
      revenue: parseMoney(col(idx, row, "total revenue", "revenue")),
      bounce_rate: bounceRaw === "" ? null : parseMoney(bounceRaw),
    });
  }
  return out;
}

function receipt(name: string, kind: string, rows: Array<{ date: string }>): AcceptedFile {
  const dated = rows.map((r) => r.date).filter(Boolean).sort();
  return {
    name,
    kind,
    rows: rows.length,
    min_date: dated[0] ?? null,
    max_date: dated[dated.length - 1] ?? null,
  };
}

export function parseNamedFile(name: string, text: string): ParsedFiles {
  const empty: ParsedFiles = {
    campaigns: [], queries: [], ga: [], sources: [], skipped: [], warnings: [], accepted: [],
  };
  const kind = detectKind(name, text);
  if (kind === "unknown") {
    empty.skipped.push(name);
    empty.warnings.push(`Could not detect type for ${name}`);
    return empty;
  }
  if (kind === "gsc_zip") {
    empty.warnings.push("Pass the zip as binary; text detect only.");
    empty.skipped.push(name);
    return empty;
  }
  try {
    if (kind === "google" || kind === "meta") {
      const campaigns = kind === "google" ? parseGoogleCsv(text) : parseMetaCsv(text);
      if (!campaigns.length) {
        empty.skipped.push(name);
        empty.warnings.push(`${name}: detected ${kind} but no usable rows`);
        return empty;
      }
      return {
        ...empty, campaigns, sources: [kind], accepted: [receipt(name, kind, campaigns)],
      };
    }
    if (kind === "gsc_queries" || kind === "gsc_pages" || kind === "gsc_chart") {
      const queries = kind === "gsc_queries" ? parseGscQueries(text)
        : kind === "gsc_pages" ? parseGscPages(text)
        : parseGscChart(text);
      if (!queries.length) {
        empty.skipped.push(name);
        empty.warnings.push(`${name}: detected ${kind} but no usable rows`);
        return empty;
      }
      return {
        ...empty, queries, sources: [kind], accepted: [receipt(name, kind, queries)],
      };
    }
    if (kind === "ga4") {
      const ga = parseGa4Csv(text);
      if (!ga.length) {
        empty.skipped.push(name);
        empty.warnings.push(`${name}: detected ga4 but no usable rows`);
        return empty;
      }
      return { ...empty, ga, sources: ["ga4"], accepted: [receipt(name, "ga4", ga)] };
    }
  } catch (e) {
    empty.skipped.push(name);
    empty.warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return empty;
}

export function parseZipBuffer(name: string, buf: Buffer): ParsedFiles {
  const files = unzipCsvs(buf);
  if (!files.length) {
    return {
      campaigns: [], queries: [], ga: [], sources: [], accepted: [],
      skipped: [name],
      warnings: [`${name}: no CSV members (send Queries.csv + Chart.csv + Pages.csv)`],
    };
  }
  return mergeParsed(files.map((f) => parseNamedFile(f.name, f.text)));
}

export function mergeParsed(parts: ParsedFiles[]): ParsedFiles {
  const out: ParsedFiles = {
    campaigns: [], queries: [], ga: [], sources: [], skipped: [], warnings: [], accepted: [],
  };
  for (const p of parts) {
    out.campaigns.push(...p.campaigns);
    out.queries.push(...p.queries);
    out.ga.push(...p.ga);
    out.sources.push(...p.sources);
    out.skipped.push(...p.skipped);
    out.warnings.push(...p.warnings);
    out.accepted.push(...p.accepted);
  }
  out.sources = [...new Set(out.sources)];
  return out;
}

/** Collapse duplicate platform|date|campaignName from one upload (last wins). */
export function dedupeCampaigns(rows: CampaignDaily[]): CampaignDaily[] {
  const map = new Map<string, CampaignDaily>();
  for (const r of rows) {
    map.set(`${r.platform}|${r.date}|${r.campaign_name}`, r);
  }
  return [...map.values()];
}

export function dedupeQueries(rows: SearchQueryDaily[]): SearchQueryDaily[] {
  const map = new Map<string, SearchQueryDaily>();
  for (const r of rows) {
    map.set(`${r.kind}|${r.date}|${r.query}`, r);
  }
  return [...map.values()];
}

export function dedupeGa(rows: GaDaily[]): GaDaily[] {
  const map = new Map<string, GaDaily>();
  for (const r of rows) {
    const key = `${r.date}|${r.channel_group}|${r.landing_page}|${r.device}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...r });
      continue;
    }
    prev.sessions += r.sessions;
    prev.active_users += r.active_users;
    prev.key_events += r.key_events;
    prev.revenue += r.revenue;
  }
  return [...map.values()];
}
