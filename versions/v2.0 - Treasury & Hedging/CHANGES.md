# v2.0 - Treasury & Hedging

**Date:** 2026-04-13

## What changed in this version

### Provision Logic Fix (backend/processor.py, importer.py, app.py)
- `get_provision_mode()` now accepts an `entity` parameter
- **SABI / SABGB**: provision rate is always 0% — these entities never use provision
- **SABIS with inventory >= 0** (NO PROVISION): rate is now correctly 0% instead of the old
  4.5%/8% hurdle that was incorrectly applied even when stock was on hand
- **SABIS with inventory < 0** (PROVISION active): rate remains 4.5% (gold) / 8% (silver)
- All callers in `app.py` and `importer.py` updated to pass entity

### Hedging VWAP (backend/app.py, frontend)
- `/api/hedging` now returns `long_vwap` and `short_vwap` (oz-weighted average open price)
- Hedging card shows VWAP next to Long/Short oz totals
- `/api/hedging` now accepts optional `from` / `to` date params for filtering by open date

### Combined Exposure View (new: /api/exposure)
- New `/api/exposure` API endpoint merges physical trading with hedge positions:
  - **Buy-side**: Buybacks + Longs (combined VWAP)
  - **Sell-side**: Sales + Shorts (combined VWAP)
- New "Combined Exposure & Treasury Alpha" panel on dashboard

### Treasury Alpha (backend/app.py, frontend/dashboard.js)
- **Formula**: `(Sell-side VWAP − Buy-side VWAP) × min(buy-side oz, sell-side oz)`
- Positive = company is selling higher than it bought (profitable spread)
- Displayed prominently in the combined exposure panel with colour coding

## Files included

- frontend/index.html
- frontend/dashboard.js
- frontend/style.css
- frontend/products.html
- backend/app.py
- backend/models.py
- backend/importer.py
- backend/processor.py
- backend/spot_prices.py
- backend/excel_writer.py
- backend/watcher.py
- backend/startup.py
- backend/seed_positions.py
- backend/sheets.py
- config/settings.json
- config/products.json
- requirements.txt
