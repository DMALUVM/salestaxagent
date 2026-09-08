"""Read-only Amazon Ads Campaigns API snapshot for GNO Export pack v2.

Lists SP campaigns, portfolios, keywords, and negatives. Never creates
Reporting v3 reports (no HTTP 425 wait-loops). Never PUT/PATCH/DELETE
campaigns, keywords, bids, budgets, or state.

Observe only.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from src.amazon_ads.auth import ads_headers
from src.amazon_ads.client import BASE_URL

log = logging.getLogger(__name__)

OBSERVE_ONLY = True

# List endpoints only. Writes (PUT/PATCH/DELETE on entities) are forbidden.
_ALLOWED_POST_SUFFIXES = (
    "/sp/campaigns/list",
    "/sp/keywords/list",
    "/sp/negativeKeywords/list",
    "/sp/campaignNegativeKeywords/list",
    "/portfolios/list",
)
_ALLOWED_GET_PATHS = (
    "/v2/portfolios",
)

ACCEPT_CAMPAIGN = "application/vnd.spCampaign.v3+json"
ACCEPT_KEYWORD = "application/vnd.spKeyword.v3+json"
ACCEPT_NEG_KW = "application/vnd.spNegativeKeyword.v3+json"
ACCEPT_CAMP_NEG = "application/vnd.spCampaignNegativeKeyword.v3+json"
ACCEPT_PORTFOLIO = "application/vnd.spPortfolio.v3+json"


class CampaignsApiError(RuntimeError):
    """Campaigns API list failed. Not a reporting-slot 425."""


def _headers(accept: str) -> dict[str, str]:
    headers = ads_headers()
    headers["Accept"] = accept
    headers["Content-Type"] = accept
    return headers


def _assert_list_only(method: str, path: str) -> None:
    method = method.upper()
    if method == "POST" and path in _ALLOWED_POST_SUFFIXES:
        return
    if method == "GET" and path in _ALLOWED_GET_PATHS:
        return
    raise CampaignsApiError(
        f"Refusing {method} {path} — Campaigns API snapshot is observe-only.")


def _request(method: str, path: str, *, accept: str,
             json_body: dict | None = None) -> dict | list:
    _assert_list_only(method, path)
    headers = _headers(accept)
    url = f"{BASE_URL}{path}"
    refreshed = False
    while True:
        resp = httpx.request(
            method, url, headers=headers, json=json_body, timeout=30)
        if resp.status_code == 401 and not refreshed:
            headers = _headers(accept)
            headers["Authorization"] = ads_headers(force_refresh=True)["Authorization"]
            refreshed = True
            continue
        if resp.status_code == 401:
            raise PermissionError("Ads API auth failed (401)")
        if resp.status_code == 403:
            raise PermissionError("Ads API forbidden (403) — check profile scope")
        # 425 is Reporting v3 slot-busy. List endpoints should not return it.
        # Do not wait-loop regardless.
        if resp.status_code == 425:
            raise CampaignsApiError(
                "Campaigns API returned HTTP 425. Do not wait-loop; retry next slot.")
        if resp.status_code == 429:
            raise CampaignsApiError(
                "Campaigns API HTTP 429. Do not wait-loop; retry next 4h slot.")
        resp.raise_for_status()
        if not resp.content:
            return {}
        return resp.json()


def _post_list(path: str, accept: str, body: dict | None = None,
               collection_keys: tuple[str, ...] = ()) -> list[dict]:
    payload = dict(body or {})
    payload.setdefault("maxResults", 100)
    items: list[dict] = []
    while True:
        data = _request("POST", path, accept=accept, json_body=payload)
        if not isinstance(data, dict):
            break
        chunk: list = []
        for key in collection_keys:
            val = data.get(key)
            if isinstance(val, list):
                chunk = val
                break
        if not chunk:
            for val in data.values():
                if isinstance(val, list) and val and isinstance(val[0], dict):
                    chunk = val
                    break
        items.extend(r for r in chunk if isinstance(r, dict))
        token = data.get("nextToken")
        if not token:
            break
        payload["nextToken"] = token
    return items


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, dict):
        return _num(v.get("budget") if "budget" in v else v.get("amount") or v.get("bid"))
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x else None  # NaN → None


def parse_placement_modifiers(campaign: dict) -> tuple[float | None, float | None, float | None]:
    """Return (tos, ros, pp) percentage modifiers.

    Amazon omits 0% placements. A TOS-only shell (140) becomes 140/0/0.
    A campaign with no placementBidding stays (None, None, None).
    """
    bidding = campaign.get("dynamicBidding") or {}
    rows = bidding.get("placementBidding") or []
    tos = ros = pp = None
    for adj in rows:
        if not isinstance(adj, dict):
            continue
        p = str(adj.get("placement") or "").upper()
        pct = _num(adj.get("percentage"))
        if pct is None:
            continue
        if "TOP" in p:
            tos = pct
        elif "PRODUCT" in p:
            pp = pct
        elif "REST" in p or "OTHER" in p:
            ros = pct
    if tos is None and ros is None and pp is None:
        return None, None, None
    return (
        tos if tos is not None else 0.0,
        ros if ros is not None else 0.0,
        pp if pp is not None else 0.0,
    )


def parse_campaign_budget(campaign: dict) -> float | None:
    return _num(campaign.get("budget") if campaign.get("budget") is not None
                else campaign.get("campaignBudgetAmount"))


def parse_portfolio_id(campaign: dict) -> str:
    raw = campaign.get("portfolioId")
    if raw is None or raw == "":
        return ""
    return str(raw)


def parse_created_at(value: Any) -> str | None:
    """Campaigns API creationDate → ISO timestamptz. Epoch ms/s or ISO."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        ms = float(value)
        if ms != ms:  # NaN
            return None
        if ms < 1e12:
            ms *= 1000
        from datetime import datetime, timezone
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()
    text = str(value).strip()
    if not text:
        return None
    if text.replace(".", "", 1).isdigit():
        try:
            return parse_created_at(float(text))
        except (TypeError, ValueError):
            return None
    from datetime import datetime, timezone
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def parse_campaign_created_at(campaign: dict) -> str | None:
    """Prefer extendedData.creationDate, then top-level aliases."""
    ext = campaign.get("extendedData") or campaign.get("extended_data") or {}
    if not isinstance(ext, dict):
        ext = {}
    for raw in (
        ext.get("creationDate"),
        ext.get("creationDateTime"),
        ext.get("createdDate"),
        campaign.get("creationDate"),
        campaign.get("creationDateTime"),
        campaign.get("createdDate"),
        campaign.get("created_at"),
    ):
        parsed = parse_created_at(raw)
        if parsed:
            return parsed
    return None


def merge_created_at(
    api_created: str | None,
    existing: str | None,
    snapshot_at: str,
) -> str:
    """API create time, else persisted first-seen, else this snapshot."""
    return api_created or existing or snapshot_at


def parse_campaign_row(campaign: dict, portfolios: dict[str, str]) -> dict:
    cid = str(campaign.get("campaignId") or "")
    name = str(campaign.get("name") or campaign.get("campaignName") or "")
    pid = parse_portfolio_id(campaign)
    tos, ros, pp = parse_placement_modifiers(campaign)
    bidding = campaign.get("dynamicBidding") or {}
    portfolio_name = portfolios.get(pid) if pid else "none"
    if not portfolio_name:
        portfolio_name = "none"
    return {
        "campaign_id": cid,
        "campaign_name": name,
        "campaign_type": "SP",
        "state": str(campaign.get("state") or campaign.get("campaignStatus") or ""),
        "daily_budget": parse_campaign_budget(campaign),
        "portfolio_id": pid or None,
        "portfolio_name": portfolio_name,
        "tos_modifier_pct": tos,
        "ros_modifier_pct": ros,
        "pp_modifier_pct": pp,
        "bidding_strategy": str(bidding.get("strategy") or "") or None,
        "created_at": parse_campaign_created_at(campaign),
    }


def parse_portfolio_row(row: dict) -> dict | None:
    pid = str(row.get("portfolioId") or row.get("id") or "")
    name = str(row.get("name") or row.get("portfolioName") or "")
    if not pid:
        return None
    return {
        "portfolio_id": pid,
        "portfolio_name": name or "none",
        "state": str(row.get("state") or ""),
    }


def parse_keyword_row(row: dict, campaigns_by_id: dict[str, str]) -> dict | None:
    kid = str(row.get("keywordId") or "")
    if not kid:
        return None
    cid = str(row.get("campaignId") or "")
    return {
        "keyword_id": kid,
        "campaign_id": cid,
        "campaign_name": campaigns_by_id.get(cid, ""),
        "ad_group_id": str(row.get("adGroupId") or "") or None,
        "keyword_text": str(row.get("keywordText") or row.get("keyword") or ""),
        "match_type": str(row.get("matchType") or ""),
        "state": str(row.get("state") or ""),
        "bid": _num(row.get("bid")),
    }


def parse_negative_row(row: dict, campaigns_by_id: dict[str, str],
                       level: str) -> dict | None:
    nid = str(row.get("keywordId") or row.get("negativeId")
              or row.get("targetId") or "")
    text = str(row.get("keywordText") or row.get("keyword") or "")
    if not nid and not text:
        return None
    cid = str(row.get("campaignId") or "")
    if not nid:
        nid = f"{level}:{cid}:{text}:{row.get('matchType') or ''}"
    return {
        "negative_id": nid,
        "campaign_id": cid or None,
        "campaign_name": campaigns_by_id.get(cid, ""),
        "ad_group_id": str(row.get("adGroupId") or "") or None,
        "keyword": text,
        "match_type": str(row.get("matchType") or ""),
        "state": str(row.get("state") or ""),
        "level": level,
    }


def list_portfolios() -> list[dict]:
    """GET /v2/portfolios, fall back to POST /portfolios/list."""
    try:
        data = _request("GET", "/v2/portfolios", accept="application/json")
        rows = data if isinstance(data, list) else (data.get("portfolios") or [])
        out = [p for r in rows if isinstance(r, dict) for p in [parse_portfolio_row(r)] if p]
        if out:
            return out
    except Exception as e:
        log.warning("v2 portfolios failed (%s) — trying v3 list", e)
    rows = _post_list(
        "/portfolios/list", ACCEPT_PORTFOLIO, {},
        collection_keys=("portfolios",))
    return [p for r in rows for p in [parse_portfolio_row(r)] if p]


def list_sp_campaigns() -> list[dict]:
    return _post_list(
        "/sp/campaigns/list", ACCEPT_CAMPAIGN,
        {"includeExtendedDataFields": True,
         "stateFilter": {"include": ["ENABLED", "PAUSED", "ARCHIVED"]}},
        collection_keys=("campaigns",))


def list_sp_keywords() -> list[dict]:
    return _post_list(
        "/sp/keywords/list", ACCEPT_KEYWORD,
        {"stateFilter": {"include": ["ENABLED", "PAUSED"]}},
        collection_keys=("keywords",))


def list_sp_negatives() -> list[dict]:
    adg = _post_list(
        "/sp/negativeKeywords/list", ACCEPT_NEG_KW,
        {"stateFilter": {"include": ["ENABLED", "PAUSED"]}},
        collection_keys=("negativeKeywords",))
    camp = _post_list(
        "/sp/campaignNegativeKeywords/list", ACCEPT_CAMP_NEG,
        {"stateFilter": {"include": ["ENABLED", "PAUSED"]}},
        collection_keys=("campaignNegativeKeywords", "negativeKeywords"))
    return [(r, "ad_group") for r in adg] + [(r, "campaign") for r in camp]


def _existing_created_at() -> dict[str, str]:
    """Persisted first-seen / API create times. Empty if column missing."""
    try:
        from src.db import get_client

        r = (
            get_client()
            .table("ads_campaign_meta")
            .select("campaign_id,created_at")
            .limit(10000)
            .execute()
        )
        out: dict[str, str] = {}
        for row in r.data or []:
            cid = str(row.get("campaign_id") or "")
            ts = row.get("created_at")
            if cid and ts:
                out[cid] = str(ts)
        return out
    except Exception as e:
        log.debug("ads_campaign_meta created_at read failed: %s", e)
        return {}


def snapshot_gno_meta() -> dict:
    """Fetch Campaigns API lists and upsert snapshot tables. Observe only."""
    from datetime import datetime, timezone

    from src.db import upsert_rows

    now = datetime.now(timezone.utc).isoformat()
    portfolios = list_portfolios()
    port_by_id = {p["portfolio_id"]: p["portfolio_name"] for p in portfolios}
    raw_campaigns = list_sp_campaigns()
    campaigns = [parse_campaign_row(c, port_by_id) for c in raw_campaigns]
    campaigns = [c for c in campaigns if c["campaign_id"]]
    existing_created = _existing_created_at()
    for row in campaigns:
        row["created_at"] = merge_created_at(
            row.get("created_at"), existing_created.get(row["campaign_id"]), now)
    name_by_id = {c["campaign_id"]: c["campaign_name"] for c in campaigns}

    keywords = [
        k for r in list_sp_keywords()
        for k in [parse_keyword_row(r, name_by_id)] if k
    ]
    negatives = [
        n for row, level in list_sp_negatives()
        for n in [parse_negative_row(row, name_by_id, level)] if n
    ]

    for row in campaigns:
        row["snapshot_at"] = now
        row["updated_at"] = now
    for row in portfolios:
        row["snapshot_at"] = now
    for row in keywords:
        row["snapshot_at"] = now
    for row in negatives:
        row["snapshot_at"] = now

    try:
        camp_n = upsert_rows(
            "ads_campaign_meta", campaigns, on_conflict="campaign_id")
    except Exception as e:
        err = str(e)
        if "created_at" in err.lower() or "PGRST204" in err:
            log.warning("Retrying ads_campaign_meta upsert without created_at: %s", err[:160])
            for row in campaigns:
                row.pop("created_at", None)
            camp_n = upsert_rows(
                "ads_campaign_meta", campaigns, on_conflict="campaign_id")
        else:
            raise
    inserted = {
        "campaigns": camp_n,
        "portfolios": upsert_rows(
            "ads_portfolios", portfolios, on_conflict="portfolio_id"),
        "keywords": upsert_rows(
            "ads_keyword_targets", keywords, on_conflict="keyword_id"),
        "negatives": upsert_rows(
            "ads_negatives", negatives, on_conflict="negative_id"),
    }
    log.info(
        "GNO Campaigns API snapshot: %s campaign(s), %s portfolio(s), "
        "%s keyword(s), %s negative(s). Observe only.",
        inserted["campaigns"], inserted["portfolios"],
        inserted["keywords"], inserted["negatives"],
    )
    return inserted
