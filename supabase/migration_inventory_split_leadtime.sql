-- First-box / last-box receive on multi-FC AWD→FBA splits.
ALTER TABLE inventory_leadtime_summary
    ADD COLUMN IF NOT EXISTS first_box_days integer,
    ADD COLUMN IF NOT EXISTS last_box_days integer,
    ADD COLUMN IF NOT EXISTS box_spread_days integer,
    ADD COLUMN IF NOT EXISTS split_n integer NOT NULL DEFAULT 0;
