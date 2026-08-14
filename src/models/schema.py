from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel


class InventoryEvent(BaseModel):
    source_file: str
    event_date: date
    fc_code: str
    state_code: Optional[str] = None
    asin: Optional[str] = None
    sku: Optional[str] = None
    fnsku: Optional[str] = None
    quantity: int = 0
    event_type: Optional[str] = None
    disposition: Optional[str] = None
    raw_data: Optional[dict] = None


class SalesByState(BaseModel):
    state_code: str
    channel: str
    period_start: date
    period_end: date
    order_count: int = 0
    gross_sales: float = 0.0
    net_sales: float = 0.0
    tax_collected: float = 0.0
    source: Optional[str] = None


class NexusStatus(BaseModel):
    state_code: str
    has_physical_nexus: bool = False
    physical_nexus_since: Optional[date] = None
    physical_nexus_source: Optional[str] = None
    has_economic_nexus: bool = False
    economic_nexus_since: Optional[date] = None
    economic_progress_amount: float = 0.0
    economic_progress_transactions: int = 0
    economic_progress_percent: float = 0.0
    is_registered: bool = False
    registration_date: Optional[date] = None
    assigned_frequency: Optional[str] = None
    requires_action: bool = False
    action_notes: Optional[str] = None
    confidence: Optional[str] = None


class StateRule(BaseModel):
    state_code: str
    state_name: str
    has_sales_tax: bool = True
    economic_threshold_amount: Optional[float] = None
    economic_threshold_transactions: Optional[int] = None
    economic_threshold_period: Optional[str] = None
    fba_inventory_creates_nexus: bool = True
    marketplace_sales_count_toward_threshold: bool = False
    filing_frequency_default: Optional[str] = None
    typical_due_day: Optional[int] = None
    franchise_tax_notes: Optional[str] = None
    notes: Optional[str] = None
    last_reviewed: Optional[date] = None


class FilingEntry(BaseModel):
    state_code: str
    period_type: str
    period_label: str
    period_start: date
    period_end: date
    due_date: date
    status: str = "pending"
    filed_date: Optional[date] = None
    filed_amount: Optional[float] = None
    filed_notes: Optional[str] = None
    is_zero_return: bool = False
    reminder_sent: bool = False


class FranchiseTaxFlag(BaseModel):
    state_code: str
    flag_type: str
    description: str
    severity: str
    trigger_reason: str
    recommended_action: Optional[str] = None
    due_date: Optional[date] = None
    status: str = "open"
    confidence: Optional[str] = None
