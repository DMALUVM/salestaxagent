"""Effective lead times: prefer measured FBA/AWD calibration, fall back to settings."""
from __future__ import annotations

from datetime import date, timedelta


def _int(val, default: int) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _signal_for(sku: str | None, signals: dict[str, dict] | None) -> dict | None:
    if not sku or not signals:
        return None
    return signals.get(sku)


def effective_fba_receive_days(
    sku: str | None,
    settings: dict,
    signals: dict[str, dict] | None = None,
    *,
    peak: bool = False,
    account_summary: dict | None = None,
) -> int:
    """Warehouse/direct inbound → FBA sellable (measured receive, else configured)."""
    sig = _signal_for(sku, signals)
    if sig and sig.get("measured_receive_days") is not None:
        return _int(sig["measured_receive_days"], 0)

    if account_summary and account_summary.get("fba_optimized_receive_median") is not None:
        return _int(account_summary["fba_optimized_receive_median"], 0)
    if account_summary and account_summary.get("fba_receive_median") is not None:
        return _int(account_summary["fba_receive_median"], 0)

    if peak:
        return _int(settings.get("receiving_days_peak"), 28)
    recv = settings.get("receiving_days_normal")
    if recv is not None:
        return _int(recv, 14)
    return _int(settings.get("lead_time_days"), 35)


def effective_awd_to_fba_days(
    sku: str | None,
    settings: dict,
    signals: dict[str, dict] | None = None,
    account_summary: dict | None = None,
) -> int:
    """AWD replenishment confirm → Prime-eligible at FC."""
    sig = _signal_for(sku, signals)
    if sig and sig.get("measured_replenish_days") is not None:
        return _int(sig["measured_replenish_days"], 0)

    if account_summary and account_summary.get("awd_replenish_median") is not None:
        return _int(account_summary["awd_replenish_median"], 0)

    if sig and sig.get("configured_awd_to_fba_days") is not None:
        return _int(sig["configured_awd_to_fba_days"], 14)
    return _int(settings.get("awd_to_fba_days"), 14)


def effective_reorder_lead_days(
    sku: str | None,
    settings: dict,
    signals: dict[str, dict] | None = None,
    *,
    awd_on_hand: int = 0,
    fba_on_hand: int = 0,
    inbound: int = 0,
    account_summary: dict | None = None,
) -> int:
    """Lead-time buffer in reorder math (target + lead) × demand."""
    fba_lead = effective_fba_receive_days(
        sku, settings, signals, account_summary=account_summary,
    )
    awd_lead = effective_awd_to_fba_days(
        sku, settings, signals, account_summary=account_summary,
    )

    # When AWD dominates supply and FBA is thin, buffer for AWD→FBA path too.
    if awd_on_hand > 0 and awd_on_hand >= fba_on_hand + inbound:
        return max(fba_lead, awd_lead)
    return fba_lead


def is_peak_receiving(settings: dict, today: date | None = None) -> bool:
    today = today or date.today()
    start = settings.get("peak_start_date")
    end = settings.get("peak_end_date")
    if not start:
        return False
    try:
        peak_start = date.fromisoformat(str(start)[:10])
    except ValueError:
        return False
    if today >= peak_start - timedelta(days=30):
        if end:
            try:
                peak_end = date.fromisoformat(str(end)[:10])
                return today <= peak_end
            except ValueError:
                pass
        return True
    return False


def load_signals_map() -> dict[str, dict]:
    try:
        from src.db import fetch_all
        rows = fetch_all("inventory_sku_signals")
    except Exception:
        return {}
    return {r["sku"]: r for r in rows if r.get("sku")}


def load_leadtime_summary() -> dict | None:
    try:
        from src.db import fetch_all
        rows = fetch_all("inventory_leadtime_summary")
    except Exception:
        return None
    if not rows:
        return None
    rows.sort(key=lambda r: r.get("as_of_date") or "", reverse=True)
    return rows[0]
