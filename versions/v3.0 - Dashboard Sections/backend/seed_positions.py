"""
Seed SABIS StoneX March 2026 positions.

Clears all existing SABIS hedging positions and inserts the reconciled
StoneX March 2026 data (period: 16 Mar – 31 Mar 2026).

Source: StoneX Financial Ltd — Account MT0795 — March 2026 Reconciliation
  XAU/USD  309 oz long  @ VWAP USD 4,450.91/oz
  XAU/ZAR   52 oz long  @ VWAP USD 4,346.08/oz
  XAG/USD 8,820 oz long @ VWAP USD    72.97/oz
  XAG/ZAR   635 oz long @ VWAP USD    69.92/oz

USD → ZAR conversion at prevailing March 2026 rate of approx 18.50 ZAR/USD.

Run: python backend/seed_positions.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from models import get_conn, set_inventory_position, init_db, insert_hedging_position

init_db()

# ── Convert USD VWAP to ZAR open price ───────────────────────────────────────
ZAR_PER_USD = 18.50   # March 2026 prevailing rate

def usd_to_zar(usd): return round(usd * ZAR_PER_USD, 2)

# ── Clear existing SABIS Stone X positions (SAM positions are preserved) ─────
print("Clearing existing SABIS Stone X hedging positions...")
conn = get_conn()
conn.execute("DELETE FROM hedging WHERE entity='SABIS' AND platform='Stone X'")
conn.commit()
conn.close()
print("  Done.  (SAM / Proofs / Other positions preserved)")

# ── Physical inventory base positions (Sage Item Valuation Report — 1 March 2026) ─
# Source: ItemValuationReport extracted from PDF (pdfplumber), all 8 pages.
# Gold items mapped to troy oz:  KR1 -1104, KR2 +465.5, KR4 +70, KR10 +13.9,
#   PKR1 +84, PKR4 +0.25, GDin +18.25, GDin852 +0.161, GM10MetCon -0.322,
#   GM10RRL +0.322, GM50 +1.608  →  Net: -450.331 oz
# Silver items mapped to troy oz: SB15000 +14467.5, SABIS1KG -12763.55,
#   SCBrit -4788, SKR1 -3516, SCCML1 +2341, SCAPhil -2322, SCBrit025 +1448.5,
#   SCAE1 +886, SCBrit010 +512, SK1 +303, SKA +256, SCBritLib +130,
#   SB1000 -96.45 + many smaller numismatic items  →  Net: -2762.330 oz
print("\nSetting physical inventory base positions (Sage Item Valuation — 1 March 2026)...")
EOD_POSITIONS = {
    ('SABIS', 'gold'):   -450.331,
    ('SABIS', 'silver'): -2762.330,
}
for (entity, metal), oz in EOD_POSITIONS.items():
    set_inventory_position(entity, metal, oz)
    print(f"  {entity} {metal:6s} -> {oz:,.2f} oz")

# ── Insert March 2026 StoneX SABIS positions ──────────────────────────────────
MARCH_POSITIONS = [
    # Gold — XAU/USD leg (309 oz @ USD 4,450.91 VWAP)
    {
        'entity':         'SABIS',
        'metal':          'gold',
        'position_type':  'long',
        'open_date':      '2026-03-16',
        'contract_oz':    309.0,
        'open_price_zar': usd_to_zar(4450.91),
        'platform':       'Stone X',
        'notes':          'XAU/USD — StoneX MT0795 March 2026 recon (USD leg)',
        'status':         'open',
    },
    # Gold — XAU/ZAR leg (52 oz @ USD 4,346.08 VWAP)
    {
        'entity':         'SABIS',
        'metal':          'gold',
        'position_type':  'long',
        'open_date':      '2026-03-16',
        'contract_oz':    52.0,
        'open_price_zar': usd_to_zar(4346.08),
        'platform':       'Stone X',
        'notes':          'XAU/ZAR — StoneX MT0795 March 2026 recon (ZAR leg)',
        'status':         'open',
    },
    # Silver — XAG/USD leg (8,820 oz @ USD 72.97 VWAP)
    {
        'entity':         'SABIS',
        'metal':          'silver',
        'position_type':  'long',
        'open_date':      '2026-03-16',
        'contract_oz':    8820.0,
        'open_price_zar': usd_to_zar(72.97),
        'platform':       'Stone X',
        'notes':          'XAG/USD — StoneX MT0795 March 2026 recon (USD leg)',
        'status':         'open',
    },
    # Silver — XAG/ZAR leg (635 oz @ USD 69.92 VWAP)
    {
        'entity':         'SABIS',
        'metal':          'silver',
        'position_type':  'long',
        'open_date':      '2026-03-16',
        'contract_oz':    635.0,
        'open_price_zar': usd_to_zar(69.92),
        'platform':       'Stone X',
        'notes':          'XAG/ZAR — StoneX MT0795 March 2026 recon (ZAR leg)',
        'status':         'open',
    },
]

print("\nInserting March 2026 StoneX SABIS positions...")
for pos in MARCH_POSITIONS:
    insert_hedging_position(pos)
    print(f"  {pos['metal']:<6}  {pos['position_type']:<5}  {pos['contract_oz']:>8,.0f} oz"
          f"  @ R{pos['open_price_zar']:>10,.2f}/oz  {pos['notes'].split('—')[0].strip()}")

# ── Verify ────────────────────────────────────────────────────────────────────
print("\n--- Verification ---")
conn = get_conn()
c = conn.cursor()

c.execute("SELECT entity, metal, total_oz FROM inventory WHERE entity='SABIS'")
print("Inventory (physical exposure):")
for r in c.fetchall():
    print(f"  {r[0]} {r[1]:6s}: {r[2]:,.2f} oz")

c.execute("""
    SELECT metal, position_type, SUM(contract_oz) AS total_oz
    FROM hedging WHERE entity='SABIS' AND status='open'
    GROUP BY metal, position_type
    ORDER BY metal, position_type
""")
rows = c.fetchall()
print("\nHedging (March 2026 StoneX totals by metal):")
for r in rows:
    print(f"  {r[0]:<6} {r[1]:<5}  {r[2]:>10,.2f} oz")

conn.close()
print("\nDone. Restart Flask if the server is running to pick up the new values.")
