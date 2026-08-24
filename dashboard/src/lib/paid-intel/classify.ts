import type { Audience, CampaignType, ProductLine } from "./types";

const BRAND_TOKEN = /\b(brand|branded)\b/i;
const BRAND_NAME = /\b(tallowbourn|tallow bourn|tallowbourne|dr dave|dr\.?\s*dave|primal essence)\b/i;
const PMAX = /\b(pmax|p-max|performance max|p max)\b/i;
const SHOPPING = /\bshopping\b/i;
const SEARCH = /\b(search|ai max)\b/i;
const RETARGET = /retarget|re-target|remarket/i;
const LIP = /\blip\b/i;
const SOAP = /\bsoap\b/i;
const DEO = /\b(deo|deodorant)\b/i;
const BALM = /\b(balm|moisturizer|moisturiser|sun balm)\b/i;

export function isBrandCampaign(name: string): boolean {
  if (PMAX.test(name)) return false;
  if (BRAND_TOKEN.test(name)) return true;
  return BRAND_NAME.test(name) && SEARCH.test(name);
}

export function campaignTypeOf(name: string, hinted?: string | null): CampaignType {
  const h = (hinted || "").toLowerCase();
  if (/performance max|pmax|cross-network/.test(h) || PMAX.test(name)) return "PMax";
  if (/shopping/.test(h) || SHOPPING.test(name)) return "Shopping";
  if (/demand.?gen|video|display/.test(h)) return "DemandGen";
  if (/search/.test(h) || SEARCH.test(name)) return "Search";
  if (h.includes("search")) return "Search";
  return "Other";
}

export function productOf(text: string): ProductLine {
  if (LIP.test(text)) return "lip";
  if (SOAP.test(text)) return "soap";
  if (DEO.test(text)) return "deodorant";
  if (BALM.test(text)) return "balm";
  return "other";
}

export function audienceOf(name: string, platform: "google" | "meta"): Audience {
  if (platform !== "meta") return "unknown";
  if (RETARGET.test(name)) return "retarget";
  if (/\b(sales|ugc|prospect|cold|testing|cbo|whitelist|promo)\b/i.test(name)) return "prospect";
  return "unknown";
}

export function isNonBrandGoogle(name: string, type: CampaignType, isBrand: boolean): boolean {
  return !isBrand && (type === "Search" || type === "Shopping" || type === "PMax" || type === "Other");
}

export { PMAX };
