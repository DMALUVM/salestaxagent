-- Daily FBA ending-warehouse-balance from GET_LEDGER_SUMMARY_VIEW_DATA
-- (aggregatedByTimePeriod=DAILY, aggregateByLocation=FC).
-- Tax / physical-nexus inventory $ at sku_costs — not the ops inventory table.
-- Run in Supabase Dashboard > SQL Editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS inventory_ledger_summary_daily (
    snapshot_date   date NOT NULL,
    sku             text NOT NULL,
    fc_code         text NOT NULL,
    state_code      text,
    disposition     text NOT NULL DEFAULT '',
    ending_qty      integer NOT NULL DEFAULT 0,
    cogs_per_unit   numeric(12,4),
    cogs_value      numeric(14,4) NOT NULL DEFAULT 0,
    ingested_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (snapshot_date, sku, fc_code, disposition)
);

CREATE INDEX IF NOT EXISTS idx_ledger_summary_state_date
    ON inventory_ledger_summary_daily (state_code, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_ledger_summary_date
    ON inventory_ledger_summary_daily (snapshot_date);

ALTER TABLE inventory_ledger_summary_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_ledger_summary_daily FORCE ROW LEVEL SECURITY;

-- Peak YTD + current on-hand by state for the tax inventory map.
-- NULL state_code (unmapped FCs) is returned as 'XX' — never invented.
CREATE OR REPLACE FUNCTION tax_inventory_state_peaks(p_year integer)
RETURNS TABLE (
    state_code text,
    peak_cogs numeric,
    peak_date date,
    current_cogs numeric,
    current_units bigint,
    current_fc_count integer
)
LANGUAGE sql
STABLE
AS $$
    WITH daily AS (
        SELECT
            snapshot_date,
            COALESCE(NULLIF(state_code, ''), 'XX') AS state_code,
            SUM(cogs_value) AS cogs,
            SUM(ending_qty) AS units,
            COUNT(DISTINCT fc_code)::integer AS fc_count
        FROM inventory_ledger_summary_daily
        WHERE EXTRACT(YEAR FROM snapshot_date) = p_year
        GROUP BY 1, 2
    ),
    peaks AS (
        SELECT DISTINCT ON (state_code)
            state_code,
            snapshot_date AS peak_date,
            cogs AS peak_cogs
        FROM daily
        ORDER BY state_code, cogs DESC, snapshot_date DESC
    ),
    latest AS (
        SELECT MAX(snapshot_date) AS d FROM daily
    ),
    current AS (
        SELECT d.state_code, d.cogs, d.units, d.fc_count
        FROM daily d
        JOIN latest l ON d.snapshot_date = l.d
    )
    SELECT
        p.state_code,
        p.peak_cogs,
        p.peak_date,
        COALESCE(c.cogs, 0),
        COALESCE(c.units, 0),
        COALESCE(c.fc_count, 0)
    FROM peaks p
    LEFT JOIN current c ON c.state_code = p.state_code;
$$;

REVOKE ALL ON FUNCTION tax_inventory_state_peaks(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tax_inventory_state_peaks(integer) TO service_role;
