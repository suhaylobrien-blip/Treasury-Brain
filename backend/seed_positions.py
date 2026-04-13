"""
Seed / reconcile end-of-day positions for SABIS.

Run this AFTER importing the dealing sheet to lock in the known
end-of-day physical inventory levels.

Usage:
    python backend/seed_positions.py
"""
import sys, os
from datetime import date

sys.path.insert(0, os.path.dirname(__file__))
from models import get_conn, set_inventory_position, init_db, insert_hedging_position

init_db()

# ── End-of-day physical inventory (set AFTER dealing sheet import) ──────────
# Reconciled positions as of close of business 9 April 2026.
EOD_POSITIONS = {
    ('SABIS', 'gold'):   -500.15,
    ('SABIS', 'silver'): -17722.89,
}

print("Setting end-of-day physical inventory positions...")
for (entity, metal), oz in EOD_POSITIONS.items():
    set_inventory_position(entity, metal, oz)
    print(f"  {entity} {metal:6s} -> {oz:,.2f} oz")


# ── Initial hedging positions (seed once — skipped if already present) ───────
# Gold:   361 oz long with Stone X @ R76,800/oz
# Silver: 7,000 oz long with SAM + 11,025 oz long with Stone X  (VWAP R1,276)
#
# Update these via the dashboard UI or by clearing and re-running this script.

INITIAL_HEDGES = [
    {
        'entity':         'SABIS',
        'metal':          'gold',
        'position_type':  'long',
        'open_date':      '2026-04-09',
        'contract_oz':    361.0,
        'open_price_zar': 76800.0,
        'platform':       'Stone X',
        'notes':          'Initial long position',
        'status':         'open',
    },
    {
        'entity':         'SABIS',
        'metal':          'silver',
        'position_type':  'long',
        'open_date':      '2026-04-09',
        'contract_oz':    7000.0,
        'open_price_zar': 1276.0,
        'platform':       'SAM',
        'notes':          'Initial long position',
        'status':         'open',
    },
    {
        'entity':         'SABIS',
        'metal':          'silver',
        'position_type':  'long',
        'open_date':      '2026-04-09',
        'contract_oz':    11025.0,
        'open_price_zar': 1276.0,
        'platform':       'Stone X',
        'notes':          'Initial long position',
        'status':         'open',
    },
]


def _hedging_count():
    conn = get_conn()
    c    = conn.cursor()
    c.execute("SELECT COUNT(*) FROM hedging WHERE entity='SABIS'")
    n = c.fetchone()[0]
    conn.close()
    return n


if _hedging_count() == 0:
    print("\nSeeding initial hedging positions...")
    for h in INITIAL_HEDGES:
        insert_hedging_position(h)
        print(f"  {h['entity']} {h['metal']:<6} {h['position_type']:<5} "
              f"{h['platform']:<8} {h['contract_oz']:>8,.0f} oz @ R{h['open_price_zar']:,.0f}")
else:
    print("\nHedging positions already present — skipping seed.")


# ── Verify ───────────────────────────────────────────────────────────────────
print("\n--- Verification ---")
conn = get_conn()
c    = conn.cursor()

c.execute("SELECT entity, metal, total_oz FROM inventory WHERE entity='SABIS'")
print("Inventory (physical):")
for r in c.fetchall():
    print(f"  {r[0]} {r[1]:6s}: {r[2]:,.2f} oz")

c.execute("""
    SELECT platform, metal, position_type, contract_oz, open_price_zar
    FROM hedging WHERE entity='SABIS' AND status='open'
    ORDER BY metal, position_type, platform
""")
rows = c.fetchall()
if rows:
    print("Hedging (open positions):")
    for r in rows:
        print(f"  {r[0]:<10} {r[1]:<6} {r[2]:<5} {r[3]:>8,.0f} oz  @ R{r[4]:,.0f}")
else:
    print("Hedging: (none)")

conn.close()
print("\nDone.  Restart Flask if server is running to pick up new values.")
