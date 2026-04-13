# v1.0 - Initial Release

**Date:** 2026-04-13

## What's in this version

- Full Treasury Brain dashboard (SABIS, SABI, SABGB entities)
- Live Au / Ag spot prices via GoldStore API
- SABI tab displays all values in USD
- Products catalogue page (`/products.html`) with live GoldStore inventory
- Products nav link in dashboard header
- GoldStore API proxy (server-side, bypasses browser CORS restrictions)
- Margin calculators (gold & silver)
- Aged inventory tracking
- Hedging positions
- Deal impact preview (what-if calculator)
- Pipeline (quote) deal management

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
