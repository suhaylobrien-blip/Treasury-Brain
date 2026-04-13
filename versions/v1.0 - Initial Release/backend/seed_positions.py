"""
Seed / reconcile end-of-day positions for SABIS.

Run this AFTER importing the dealing sheet to lock in the known
end-of-day physical inventory levels.  Hedging positions are NOT
touched — manage those via the dashboard UI.

Usage:
    python backend/seed_positions.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from models import get_conn, set_inventory_position, init_db

init_db()

# ── End-of-day physical inventory (set AFTER dealing sheet import) ──────────
# These are the reconciled positions as of close of business 9 April 2026.
# Update these values each day after importing the day's dealing sheet.
EOD_POSITIONS = {
    ('SABIS', 'gold'):   -500.15,
    ('SABIS', 'silver'): -17722.89,
}

print("Setting end-of-day physical inventory positions...")
for (entity, metal), oz in EOD_POSITIONS.items():
    set_inventory_position(entity, metal, oz)
    print(f"  {entity} {metal:6s} -> {oz:,.2f} oz")

print("\nHedging positions left untouched (manage via dashboard UI).")

# ── Verify ───────────────────────────────────────────────────────────────────
print("\n--- Verification ---")
conn = get_conn()
c    = conn.cursor()

c.execute("SELECT entity, metal, total_oz FROM inventory WHERE entity='SABIS'")
print("Inventory (physical exposure):")
for r in c.fetchall():
    print(f"  {r[0]} {r[1]:6s}: {r[2]:,.2f} oz")

c.execute("""
    SELECT platform, metal, position_type, contract_oz
    FROM hedging WHERE entity='SABIS' AND status='open'
    ORDER BY metal, platform
""")
rows = c.fetchall()
if rows:
    print("Hedging (unchanged):")
    for r in rows:
        print(f"  {r[0]:<8} {r[1]:<6} {r[2]:<5} {r[3]:>8,.0f} oz")
else:
    print("Hedging: (none — add via dashboard Hedging section)")

conn.close()
print("\nDone.  Restart Flask if server is running to pick up new values.")
