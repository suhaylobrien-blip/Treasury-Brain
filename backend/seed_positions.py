"""
Seed script — sets the SABIS ecosystem exposure and hedging positions
directly into the database. Run once after a fresh import.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from models import get_conn, set_inventory_position, init_db
from datetime import date

init_db()

# ── Physical bullion exposure positions (net oz from ecosystem) ───────────
set_inventory_position('SABIS', 'gold',   -500.15)
set_inventory_position('SABIS', 'silver', -17722.89)
print("Inventory/exposure set:")
print("  SABIS gold   = -500.15 oz")
print("  SABIS silver = -17,722.89 oz")

# ── Hedging positions — clear existing open, then re-seed ─────────────────
conn = get_conn()
conn.execute("DELETE FROM hedging WHERE entity='SABIS' AND status='open'")
conn.commit()
conn.close()
print("\nCleared old open SABIS hedging positions")

today = date.today().isoformat()
positions = [
    # GOLD
    dict(entity='SABIS', metal='gold',   position_type='long', open_date=today,
         contract_oz=413.0,   open_price_zar=0.0, platform='Stone X', status='open'),
    dict(entity='SABIS', metal='gold',   position_type='long', open_date=today,
         contract_oz=86.0,    open_price_zar=0.0, platform='Proofs',  status='open'),
    # SILVER
    dict(entity='SABIS', metal='silver', position_type='long', open_date=today,
         contract_oz=10614.0, open_price_zar=0.0, platform='Stone X', status='open'),
    dict(entity='SABIS', metal='silver', position_type='long', open_date=today,
         contract_oz=7000.0,  open_price_zar=0.0, platform='SAM',     status='open'),
]

conn = get_conn()
c = conn.cursor()
for pos in positions:
    cols = ', '.join(pos.keys())
    phs  = ', '.join(['?'] * len(pos))
    c.execute(f"INSERT INTO hedging ({cols}) VALUES ({phs})", list(pos.values()))
    print(f"  + {pos['platform']:<8} {pos['metal']:<6} long  {pos['contract_oz']:>8,.0f} oz")
conn.commit()

# ── Verification ──────────────────────────────────────────────────────────
print("\n--- Verification ---")
c.execute("SELECT entity, metal, total_oz FROM inventory WHERE entity='SABIS'")
print("Inventory (exposure):")
for r in c.fetchall():
    print(f"  SABIS {r[1]}: {r[2]:,.2f} oz")

c.execute("""
    SELECT platform, metal, position_type, contract_oz
    FROM hedging WHERE entity='SABIS' AND status='open'
    ORDER BY metal, platform
""")
print("Hedging positions:")
for r in c.fetchall():
    print(f"  {r[0]:<8} {r[1]:<6} {r[2]:<5} {r[3]:>8,.0f} oz")

conn.close()
print("\nDone.")
