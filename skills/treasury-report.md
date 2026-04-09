# treasury-report

Generate end-of-day consolidated Treasury Brain report (Excel + print-ready).

## When to use
At end of business each day, or when an on-demand report is needed.

## Steps

1. Ensure spot prices are current:
   ```bash
   cd backend
   python -c "from spot_prices import fetch_all_spots; print(fetch_all_spots())"
   ```
   If API key is not configured, manually enter spot prices via the dashboard or:
   ```bash
   python -c "from models import insert_spot_price; insert_spot_price('gold', 55000, 'manual')"
   ```

2. Build daily summaries for all entity + metal combinations:
   ```python
   from models import get_deals, get_inventory, get_latest_spot, upsert_daily_summary
   from processor import build_daily_summary
   from datetime import date

   entities = ['SABIS', 'SABI', 'SABGB']
   metals   = ['gold', 'silver']
   summaries = []

   for entity in entities:
       for metal in metals:
           deals = get_deals(entity, metal, date.today().isoformat())
           inv   = get_inventory(entity, metal)
           spot  = get_latest_spot(metal)
           s     = build_daily_summary(entity, metal, deals, inv, spot)
           s['entity'] = entity
           s['metal']  = metal
           summaries.append(s)
           upsert_daily_summary(s)
   ```

3. Generate the consolidated Excel report:
   ```python
   from excel_writer import generate_daily_report
   path = generate_daily_report(summaries)
   print(f"Report saved: {path}")
   ```

4. Report is saved to `reports/Treasury_Daily_Report_YYYY-MM-DD.xlsx`.

## What the report contains
- One row per entity + metal combination
- Buy/sell volumes (oz and ZAR)
- Buy/sell VWAP and margin VWAP
- Total GP contribution (ZAR)
- Current inventory (oz and ZAR value)
- Provision mode status and rate
- Spot price used

## Optional: Update Google Sheets too
```python
from sheets import write_daily_summary
for s in summaries:
    write_daily_summary(s['entity'], s['metal'], s)
```
(Requires Google Sheets credentials in `config/credentials.json` and Sheet IDs in `config/settings.json`)
