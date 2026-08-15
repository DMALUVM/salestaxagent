"""Amazon Selling Partner API (SP-API) integration.

Handles LWA authentication, report requests, and data ingestion
for sales orders and inventory ledger reports.

DATA SOURCE PRIORITY
--------------------
Once SP-API is connected, it is the **primary** source for Amazon data:

  - ``amazon_spapi`` — live API pull, complete order + inventory data.
  - ``amazon_custom_combined_tax`` — CSV upload, historical / secondary.
    Useful as a one-time backfill or cross-check, but the SP-API data
    is more complete and does not require manual downloads.

The economic nexus engine deduplicates overlapping (state, channel, period)
records and prefers SP-API data when both exist for the same period.
"""
