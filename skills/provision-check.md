# provision-check

Check provision mode status and inventory levels across all entities and metals.

## When to use
Any time you need a quick read on which entities are in PROVISION vs NO PROVISION mode, and what the current inventory position looks like.

## Quick check (all entities + metals)

```python
from models import get_inventory, get_latest_spot
from processor import get_provision_mode

entities = ['SABIS', 'SABI', 'SABGB']
metals   = ['gold', 'silver']

for entity in entities:
    for metal in metals:
        inv  = get_inventory(entity, metal)
        spot = get_latest_spot(metal)
        prov = get_provision_mode(inv, metal)
        print(f"{entity} {metal.upper()}: {inv:+.4f} oz | {prov['mode']} ({prov['rate_pct']}%) | Value: R{inv*spot:,.0f}")
```

## Aged inventory check

```python
from models import get_aged_inventory
from processor import flag_dormant, optimal_exit_suggestion
from datetime import datetime

entity = 'SABIS'
metal  = 'gold'
spot   = get_latest_spot(metal)
inv_oz = get_inventory(entity, metal)
prov   = get_provision_mode(inv_oz, metal)
parcels = get_aged_inventory(entity, metal)

for p in parcels:
    acq = datetime.strptime(p['acquired_date'], '%Y-%m-%d').date()
    dom = flag_dormant(acq)
    status = f"{dom['days_held']}d - {dom['status']}"
    suggestion = ''
    if dom['flagged']:
        suggestion = optimal_exit_suggestion({**p, 'metal': metal}, spot, prov['rate_pct'])
    print(f"  {p['acquired_date']}: {p['oz']:.4f}oz @ R{p['cost_price_zar']:,.0f} | {status} | {suggestion}")
```

## What the output means

| Mode | Inventory | Meaning |
|---|---|---|
| NO PROVISION | ≥ 0 oz | Stock on hand, no carry cost |
| PROVISION | < 0 oz | Oversold — company using client float. Gold: 4.5%, Silver: 8% |

## Provision flip alert
If a proposed deal would flip provision mode, use the preview endpoint before confirming:
```
POST /api/preview
{ "entity": "SABIS", "metal": "gold", "deal_type": "sell", "units": 100, "equiv_oz": 1, "margin_pct": 5 }
```
Look for `provision_flips: true` and `flip_alert` in the response.
