export interface NexusStatus {
  id?: string;
  state_code: string;
  has_physical_nexus: boolean;
  physical_nexus_since: string | null;
  physical_nexus_source: string | null;
  has_economic_nexus: boolean;
  economic_nexus_since: string | null;
  economic_progress_amount: number | null;
  economic_progress_transactions: number | null;
  economic_progress_percent: number | null;
  is_registered: boolean;
  registration_date: string | null;
  assigned_frequency: string | null;
  last_filed_through: string | null;
  requires_action: boolean;
  action_notes: string | null;
  confidence: string | null;
  account_number: string | null;
  updated_at: string;
}

export interface StateRule {
  state_code: string;
  state_name: string;
  has_sales_tax: boolean;
  economic_threshold_amount: number | null;
  economic_threshold_transactions: number | null;
  threshold_test_type: string | null;
  fba_inventory_creates_nexus: string;
  marketplace_sales_count_toward_threshold: boolean;
  filing_frequency_default: string | null;
  typical_due_day: number | null;
  franchise_tax_notes: string | null;
  notes: string | null;
  last_reviewed: string | null;
}

export interface FilingEntry {
  id: string;
  state_code: string;
  period_type: string;
  period_label: string;
  period_start: string;
  period_end: string;
  due_date: string;
  status: string;
  filed_amount: number | null;
  filed_at: string | null;
  filed_date: string | null;
  filed_notes: string | null;
  notes: string | null;
  is_zero_return: boolean;
  reminder_sent: boolean;
  updated_at: string;
}

export interface Alert {
  id: string;
  alert_type: string;
  state_code: string | null;
  severity: string;
  title: string;
  message: string;
  channel: string;
  sent_at: string;
  acknowledged: boolean;
}

export interface FranchiseTaxFlag {
  id: string;
  state_code: string;
  flag_type: string;
  description: string;
  severity: string;
  trigger_reason: string | null;
  recommended_action: string | null;
  confidence: string;
  status: string;
  created_at: string;
}

export interface NexusRule {
  id: string;
  state_code: string;
  rule_type: string;
  position_summary: string;
  position_detail: string | null;
  confidence: string;
  conservative_position: string | null;
  aggressive_position: string | null;
  effective_date: string | null;
  primary_sources: Source[];
  secondary_sources: Source[] | null;
  notes: string | null;
  open_questions: string | null;
  last_reviewed: string | null;
  is_active: boolean;
}

export interface Source {
  type: string;
  citation: string;
  description?: string;
}

export interface CourtRuling {
  id: string;
  case_name: string;
  citation: string;
  court: string;
  jurisdiction: string;
  decision_date: string;
  holding_summary: string;
  holding_detail: string | null;
  relevance_to_fba: string | null;
  states_affected: string[];
  status: string;
  status_notes: string | null;
  opinion_url: string | null;
  tags: string[];
  is_active: boolean;
  last_reviewed: string | null;
}

export interface AdminRuling {
  id: string;
  title: string;
  issuing_body: string;
  jurisdiction: string;
  issue_date: string;
  summary: string;
  relevance_to_fba: string | null;
  states_affected: string[];
  status: string;
  url: string | null;
  is_active: boolean;
  last_reviewed: string | null;
}

export interface IngestionLog {
  id: string;
  filename: string;
  file_type: string;
  file_hash: string | null;
  rows_total: number;
  rows_inserted: number;
  rows_skipped: number;
  warnings: string[] | null;
  status: string;
  error_message: string | null;
  ingested_at: string;
}

export interface ResearchTask {
  id: string;
  title: string;
  description: string | null;
  state_code: string | null;
  priority: string;
  task_type: string | null;
  status: string;
  created_at: string;
}

export interface SalesByState {
  id: string;
  state_code: string;
  channel: string;
  period_start: string;
  period_end: string;
  order_count: number;
  gross_sales: number;
  net_sales: number;
  tax_collected: number;
  source: string | null;
  ingested_at: string;
}

export interface SalesBySku {
  id: string;
  channel: string;
  sku: string;
  asin: string | null;
  product_title: string | null;
  state_code: string;
  period_start: string;
  period_end: string;
  units: number;
  gross_sales: number;
  net_sales: number | null;
  refund_units: number;
  refund_sales: number;
  order_count: number | null;
  source: string | null;
  ingested_at: string;
}

export interface RegistrationRow {
  state_code: string;
  state_name: string;
  has_sales_tax: boolean;
  is_registered: boolean;
  registration_date: string | null;
  assigned_frequency: string | null;
  typical_due_day: number | null;
  notes: string | null;
  filing_frequency_default: string | null;
}

export interface SalesDaily {
  sale_date: string;
  channel: string;
  gross_sales: number;
  order_count: number;
  source: string;
  updated_at: string;
}

export interface InventorySnapshot {
  sku: string;
  asin: string | null;
  fnsku: string | null;
  product_name: string | null;
  fulfillable: number;
  inbound_working: number;
  inbound_shipped: number;
  inbound_receiving: number;
  reserved: number;
  researching: number;
  unfulfillable: number;
  total_quantity: number;
  snapshot_at?: string | null;
}

export interface SkuVelocity {
  sku: string;
  asin: string | null;
  product_name: string | null;
  amazon_u_7: number;
  amazon_u_14: number;
  amazon_u_30: number;
  amazon_u_90: number;
  shopify_u_7: number;
  shopify_u_14: number;
  shopify_u_30: number;
  shopify_u_90: number;
  total_u_7: number;
  total_u_14: number;
  total_u_30: number;
  total_u_90: number;
  seasonality_mult: number;
  seasonal_total_u_30: number;
  planning_u_30?: number;
  holiday_prior_daily?: number;
  holiday_surge_mult?: number;
  yoy_growth_mult?: number;
}

export interface InventoryRestock {
  sku: string;
  asin: string | null;
  product_name: string | null;
  recommended_qty: number;
  recommended_ship_date: string | null;
  days_of_supply: number | null;
  units_sold_30: number;
  available: number;
  inbound: number;
  alert: string | null;
  pulled_at?: string | null;
}

export interface InventorySettings {
  target_cover_days: number;
  lead_time_days: number;
  holiday_mode: boolean;
  include_inbound: boolean;
  include_3pl: boolean;
  include_awd: boolean;
  receiving_days_normal: number;
  receiving_days_peak: number;
  awd_to_fba_days: number;
  production_lead_days: number;
  peak_start_date: string | null;
  peak_end_date: string | null;
}

export interface InventorySkuSignals {
  sku: string;
  as_of_date: string;
  orders_u_7: number;
  orders_u_30: number;
  inventory_u_7: number | null;
  inventory_u_30: number | null;
  rate_divergence_pct: number | null;
  rate_agreement: string | null;
  measured_receive_days: number | null;
  receive_sample_n: number;
  configured_lead_days: number;
  measured_replenish_days: number | null;
  replenish_sample_n: number;
  configured_awd_to_fba_days: number | null;
}

export interface InventoryLeadtimeSummary {
  as_of_date: string;
  fba_receive_median: number | null;
  fba_receive_n: number;
  fba_optimized_receive_median: number | null;
  fba_optimized_receive_n: number;
  fba_single_receive_median: number | null;
  fba_single_receive_n: number;
  awd_replenish_median: number | null;
  awd_replenish_n: number;
  configured_awd_to_fba_days: number | null;
}

export interface SeasonalityWeekly {
  week: number;
  multiplier: number;
  units_actual: number;
  baseline_units: number;
}

export interface Inventory3plSnapshot {
  sku: string;
  product_name: string | null;
  available: number;
  committed: number;
  reserved: number;
  incoming: number;
  warehouse: string | null;
  pulled_at?: string | null;
}
