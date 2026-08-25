"""Inventory management — FBA restock planning with seasonality.

Modules:
  sync           — pull SP-API restock/planning/FBA summaries
  velocity       — compute unit velocity + seasonality from order history
  holiday_surge  — per-SKU Nov–Dec surge from prior-year sales_by_sku
  report         — terminal summary of at-risk SKUs and reorder plan
"""
