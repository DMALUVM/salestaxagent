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
