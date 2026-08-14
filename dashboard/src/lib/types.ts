export interface NexusStatus {
  id: string;
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
  fba_inventory_creates_nexus: boolean;
  marketplace_sales_count_toward_threshold: boolean;
  filing_frequency_default: string | null;
  franchise_tax_notes: string | null;
  notes: string | null;
  last_reviewed: string | null;
}

export interface FilingEntry {
  id: string;
  state_code: string;
  period_label: string;
  due_date: string;
  frequency: string;
  status: string;
  filed_amount: number | null;
  filed_at: string | null;
  notes: string | null;
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
  source: string;
  filename: string | null;
  rows_processed: number | null;
  rows_inserted: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
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
