# treasury-import

Import and process a dealer Excel file into Treasury Brain.

## When to use
When a dealer Excel file needs to be processed (manually or as part of the watched inbox flow).

## Steps

1. Identify the file to import:
   - If a file path is provided, use it directly.
   - Otherwise check `data/inbox/` for any `.xlsx` / `.xls` files.

2. Run the importer:
   ```bash
   cd backend
   python -c "from importer import process_file; print(process_file('PATH_TO_FILE'))"
   ```

3. Review the result:
   - `status: success` — all deals imported cleanly.
   - `status: partial` — some deals imported but there were row-level warnings; review `warnings`.
   - `status: error` — no deals imported; file moved to `data/errors/`. Check the `.error.txt` file alongside it.

4. After a successful import, the daily summary auto-updates. Verify:
   ```bash
   python -c "
   from models import get_deals, get_inventory, get_latest_spot
   from processor import build_daily_summary
   import json
   deals = get_deals('SABIS', 'gold')
   inv = get_inventory('SABIS', 'gold')
   spot = get_latest_spot('gold')
   print(json.dumps(build_daily_summary('SABIS', 'gold', deals, inv, spot), indent=2))
   "
   ```

## Common validation errors and fixes

| Error | Fix |
|---|---|
| `missing required field 'silo'` | Add a `Silo` column to the dealer sheet (retail / wholesale / custody) |
| `missing required field 'channel'` | Add a `Channel` column (digital / dealer) |
| `deal_type must be 'buy' or 'sell'` | Check the Type column — must be exactly `buy` or `sell` |
| `entity must be SABIS, SABI or SABGB` | Ensure the Entity column uses one of the three approved codes |
| `metal must be 'gold' or 'silver'` | Ensure metal values are lowercase `gold` or `silver` |
