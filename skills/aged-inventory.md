# aged-inventory

Review all inventory parcels sorted by age, with exit suggestions for slow-moving stock.

## When to use
Any time you need to identify which inventory is sitting too long and what to do with it.

## Quick aged inventory review

```python
from models import get_aged_inventory, get_inventory, get_latest_spot
from processor import flag_dormant, optimal_exit_suggestion, get_provision_mode
from datetime import datetime

entity = 'SABIS'
metal  = 'gold'
spot   = get_latest_spot(metal)
inv_oz = get_inventory(entity, metal)
prov   = get_provision_mode(inv_oz, metal)
parcels = get_aged_inventory(entity, metal)

print(f"\n{entity} {metal.upper()} — Aged Inventory Report")
print(f"Current inventory: {inv_oz:+.4f}oz | Spot: R{spot:,.0f}/oz | Provision: {prov['mode']}")
print("-" * 80)

for p in parcels:
    acq = datetime.strptime(p['acquired_date'], '%Y-%m-%d').date()
    dom = flag_dormant(acq)
    flag = "⚠ SLOW" if dom['flagged'] else "  ACTIVE"
    print(f"{flag} | Acquired: {p['acquired_date']} | {p['oz']:.4f}oz | Cost: R{p['cost_price_zar']:,.0f} | {dom['days_held']}d held")
    if dom['flagged']:
        suggestion = optimal_exit_suggestion({**p, 'metal': metal}, spot, prov['rate_pct'])
        print(f"         → {suggestion}")
```

## Dashboard view
The aged inventory table is visible on the live dashboard at [http://localhost:5000](http://localhost:5000), sorted oldest to newest with exit suggestions inline.

## API endpoint

```
GET /api/inventory?entity=SABIS&metal=gold
```

Response includes:
- `aged_parcels` — list of all active inventory parcels
- Each parcel has `dormancy.days_held`, `dormancy.flagged`, `dormancy.status`
- Flagged parcels include `exit_suggestion` text

## Understanding exit suggestions

The `optimal_exit_suggestion` function calculates:
- **Break-even %**: what margin over spot is needed to recover the acquisition cost
- **Provision coverage**: does the current provision rate cover the break-even margin?
- If yes → "Sell now profitable"
- If no  → "Hold: need spot to move X% higher"

## Dormancy threshold
Currently set to **14 days** (configurable in `config/settings.json` → `dormancy_threshold_days`).
