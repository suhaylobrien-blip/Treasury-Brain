"""
Seed SABIS StoneX March-April 2026 reconciled positions.

Sources:
  [1] StoneX March 2026 Recon Report  (16-Mar to 31-Mar-2026)
  [2] StoneX March 2026 Recon.xlsx   (individual FNC/SWT trade detail)
  [3] March stone x $.xlsx           (USD statement -- full ledger)
  [4] 90-day USD/ZAR statements      (13-Mar to 17-Apr-2026)

ZAR price per oz = USD price/oz x exact USD/ZAR rate from matched FX leg.
Every FNC metal trade has a paired FNC USD/ZAR leg -- the stated rate is used
directly. No estimated or average rates.

April SHORT positions: ZAR/USD derived from statement close
  R23,956,458.07 Dr / (244 x $4,859.33 + 3,492 x $81.557) = 16.2917

Run: python backend/seed_positions.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from models import (get_conn, set_inventory_position, init_db,
                    insert_hedging_position, insert_funding_cost)

init_db()

conn = get_conn()
print("Clearing existing SABIS Stone X hedging positions...")
conn.execute("DELETE FROM hedging WHERE entity='SABIS' AND platform='Stone X'")
print("Clearing existing SABIS Stone X funding costs...")
conn.execute("DELETE FROM funding_costs WHERE entity='SABIS' AND platform='Stone X'")
conn.commit()
conn.close()
print("  Done. (SAM positions and inventory base preserved)\n")

# -- Physical base (Sage Item Valuation -- 1 March 2026) -------------------------
for (entity, metal), oz in {('SABIS','gold'): -450.331, ('SABIS','silver'): -2762.330}.items():
    set_inventory_position(entity, metal, oz)
print("Physical base: Au -450.331 oz | Ag -2,762.330 oz\n")

# =============================================================================
# MARCH 2026 LONG POSITIONS
# ZAR price/oz = sum(USD amount x USD/ZAR rate per FNC pair) / total oz
# =============================================================================

# -- XAU/ZAR legs -- direct ZAR price from statement [2] p.7 ------------------
XAU_ZAR = [
    ('2026-03-23', 12,  73_192.16, 'FNC/2026/074868'),
    ('2026-03-23', 40,  75_087.72, 'FNC/2026/076104'),
]

# -- XAG/ZAR legs -- direct ZAR price from statement [2] p.7 ------------------
XAG_ZAR = [
    ('2026-03-19', 135, 1_227.9749, 'FNC/2026/070490'),
    ('2026-03-19', 100, 1_215.0768, 'FNC/2026/070573'),
    ('2026-03-23', 200, 1_148.1720, 'FNC/2026/075477'),
    ('2026-03-23', 200, 1_160.9917, 'FNC/2026/075966'),
]

# -- XAU/USD legs -- daily batches; VWAP = zar_total / gross_oz ---------------
# 24-Mar: 160 oz bought, 5 oz sold (FNC/077779); net=155. VWAP on gross 160.
XAU_USD = [
    # date,        net_oz, zar_total,       gross_oz
    ('2026-03-24', 155, 12_039_179.14, 160),
    ('2026-03-25',  48,  3_697_535.75,  48),
    ('2026-03-26',  50,  3_797_663.31,  50),
    ('2026-03-27',  45,  3_426_858.68,  45),
    ('2026-03-31',  11,    861_352.02,  11),
]

# -- XAG/USD legs -- daily batches from [3] FNC pairs -------------------------
XAG_USD = [
    ('2026-03-16', 2_500,  3_330_633.08),
    ('2026-03-17',   250,    337_041.35),
    ('2026-03-19',   705,    824_762.85),
    ('2026-03-23',   300,    335_328.98),
    ('2026-03-24', 1_700,  2_019_376.04),
    ('2026-03-25',   210,    258_060.82),
    ('2026-03-26',   400,    475_265.80),
    ('2026-03-27',   250,    305_536.40),
    ('2026-03-30', 1_650,  2_003_607.67),
    ('2026-03-31',   855,  1_068_351.50),
]

print("Inserting March 2026 LONG positions (exact ZAR from FNC trade pairs)...")

for date, oz, zar_price, doc in XAU_ZAR:
    insert_hedging_position({
        'entity': 'SABIS', 'metal': 'gold', 'position_type': 'long',
        'open_date': date, 'contract_oz': float(oz),
        'open_price_zar': round(zar_price, 2), 'platform': 'Stone X',
        'notes': f'XAU/ZAR long {doc}', 'status': 'open',
    })
    print(f"  XAU/ZAR LONG  {oz:4}oz  @ R{zar_price:>12,.2f}  {date}")

for date, oz, zar_price, doc in XAG_ZAR:
    insert_hedging_position({
        'entity': 'SABIS', 'metal': 'silver', 'position_type': 'long',
        'open_date': date, 'contract_oz': float(oz),
        'open_price_zar': round(zar_price, 4), 'platform': 'Stone X',
        'notes': f'XAG/ZAR long {doc}', 'status': 'open',
    })
    print(f"  XAG/ZAR LONG  {oz:4}oz  @ R{zar_price:>12,.4f}  {date}")

for date, net_oz, zar_total, gross_oz in XAU_USD:
    vwap = round(zar_total / gross_oz, 2)
    insert_hedging_position({
        'entity': 'SABIS', 'metal': 'gold', 'position_type': 'long',
        'open_date': date, 'contract_oz': float(net_oz),
        'open_price_zar': vwap, 'platform': 'Stone X',
        'notes': f'XAU/USD long -- R{zar_total:,.0f}/{gross_oz}oz = R{vwap:,.2f}',
        'status': 'open',
    })
    print(f"  XAU/USD LONG  {net_oz:4}oz  @ R{vwap:>12,.2f}  {date}")

for date, oz, zar_total in XAG_USD:
    vwap = round(zar_total / oz, 4)
    insert_hedging_position({
        'entity': 'SABIS', 'metal': 'silver', 'position_type': 'long',
        'open_date': date, 'contract_oz': float(oz),
        'open_price_zar': vwap, 'platform': 'Stone X',
        'notes': f'XAG/USD long -- R{zar_total:,.0f}/{oz}oz = R{vwap:,.4f}',
        'status': 'open',
    })
    print(f"  XAG/USD LONG  {oz:4}oz  @ R{vwap:>12,.4f}  {date}")

# =============================================================================
# APRIL 2026 LONG POSITIONS
# Same methodology as March -- daily FNC BUY batches, VWAP = zar_total / oz
# Source: [4] 90-day USD statement FNC trade detail
# No XAU/ZAR or XAG/ZAR direct ZAR trades in April (all USD+ZAR combo legs)
# =============================================================================

# -- April XAU/USD daily batches ----------------------------------------------
# 01-Apr: FNC/085922 26oz R2,072,765.51 + FNC/086120 5oz R397,638.87
# 02-Apr: FNC/087543 20oz R1,569,014.93 + FNC/087909 1oz R78,073.39
#                  + FNC/087925 20oz R1,563,814.92
# 09-Apr: FNC/091557 10oz R779,186.17 + FNC/091590 10oz R780,317.32
# 10-Apr: FNC/092536 24oz R1,875,898.36 + FNC/092542 10oz R782,221.22
#                  + FNC/092560 18oz R1,409,115.48
# 14-Apr: FNC/094178 15oz R1,169,244.53 + FNC/094203 10oz R781,624.28
#       + FNC/094215 20oz R1,563,752.01 + FNC/094384 10oz R781,435.08
#       + FNC/094452 46oz R3,592,289.83 + FNC/094539 20oz R1,562,729.52
#       + FNC/094551  5oz R390,494.36
# 15-Apr: FNC/095643 9oz R709,799.51
# 16-Apr: FNC/096262 10oz R789,376.38 + FNC/096778 10oz R787,532.56
APR_XAU_USD = [
    # date,        oz,  zar_total
    ('2026-04-01',  31,  2_470_404.38),
    ('2026-04-02',  41,  3_210_903.24),
    ('2026-04-09',  20,  1_559_503.49),
    ('2026-04-10',  52,  4_067_235.06),
    ('2026-04-14', 126,  9_841_569.61),
    ('2026-04-15',   9,    709_799.51),
    ('2026-04-16',  20,  1_576_908.94),
]

# -- April XAG/USD daily batches ----------------------------------------------
# 01-Apr: FNC/086280 200oz R252,978.26 + FNC/086622 550oz R692,243.36
# 02-Apr: FNC/087241 150oz R182,199.35 + FNC/087346 150oz R181,616.21
#       + FNC/087488 200oz R241,704.35 + FNC/087858 193oz R229,600.70
# 08-Apr: FNC/090466 102oz R128,871.22
# 10-Apr: FNC/092518 411oz R509,382.73
# 14-Apr: FNC/094611 490oz R621,033.27 + FNC/094641 2000oz R2,537,805.95
#       + FNC/094667 2000oz R2,548,047.85 + FNC/094720 4000oz R5,108,362.45
#       + FNC/094736 104oz R133,382.03 + FNC/094919 500oz R648,311.68
#       + FNC/095004 500oz R647,720.65
# 15-Apr: FNC/095636 61oz R79,061.03
# 17-Apr: FNC/097325 40oz R52,202.29
APR_XAG_USD = [
    # date,          oz,   zar_total
    ('2026-04-01',   750,    945_221.62),
    ('2026-04-02',   693,    835_120.61),
    ('2026-04-08',   102,    128_871.22),
    ('2026-04-10',   411,    509_382.73),
    ('2026-04-14', 9_594, 12_244_663.88),
    ('2026-04-15',    61,     79_061.03),
    ('2026-04-17',    40,     52_202.29),
]

print("\nInserting April 2026 LONG positions (exact ZAR from FNC trade pairs)...")

for date, oz, zar_total in APR_XAU_USD:
    vwap = round(zar_total / oz, 2)
    insert_hedging_position({
        'entity': 'SABIS', 'metal': 'gold', 'position_type': 'long',
        'open_date': date, 'contract_oz': float(oz),
        'open_price_zar': vwap, 'platform': 'Stone X',
        'notes': f'XAU/USD long -- R{zar_total:,.0f}/{oz}oz = R{vwap:,.2f}',
        'status': 'open',
    })
    print(f"  XAU/USD LONG  {oz:4}oz  @ R{vwap:>12,.2f}  {date}")

for date, oz, zar_total in APR_XAG_USD:
    vwap = round(zar_total / oz, 4)
    insert_hedging_position({
        'entity': 'SABIS', 'metal': 'silver', 'position_type': 'long',
        'open_date': date, 'contract_oz': float(oz),
        'open_price_zar': vwap, 'platform': 'Stone X',
        'notes': f'XAG/USD long -- R{zar_total:,.0f}/{oz}oz = R{vwap:,.4f}',
        'status': 'open',
    })
    print(f"  XAG/USD LONG  {oz:6,.0f}oz  @ R{vwap:>12,.4f}  {date}")

# =============================================================================
# APRIL 2026 SHORT POSITIONS (residual open book at 17-Apr close)
# Rate: ZAR Dr R23,956,458.07 / (244 x $4,859.33 + 3,492 x $81.557) = 16.2917
# =============================================================================
_APR_RATE = 23_956_458.07 / ((244 * 4_859.33) + (3_492 * 81.557))

APRIL_SHORTS = [
    ('gold',   244.0,   4_859.33, 'SWT/2026/056303'),
    ('silver', 3_492.0,    81.557, 'SWT/2026/056304'),
]

print(f"\nInserting April 2026 SHORT positions (rate {_APR_RATE:.4f} ZAR/USD)...")
for metal, oz, usd_vwap, ref in APRIL_SHORTS:
    zar = round(usd_vwap * _APR_RATE, 2)
    insert_hedging_position({
        'entity': 'SABIS', 'metal': metal, 'position_type': 'short',
        'open_date': '2026-04-17', 'contract_oz': oz,
        'open_price_zar': zar, 'platform': 'Stone X',
        'notes': f'{"XAU" if metal=="gold" else "XAG"} short {ref} (90-day stmt close)',
        'status': 'open',
    })
    print(f"  {'XAU' if metal=='gold' else 'XAG'} SHORT {oz:6,.0f}oz  @ R{zar:>12,.2f}"
          f"  (${usd_vwap} x {_APR_RATE:.4f})")

# =============================================================================
# MARCH 2026 SWAP FEES
# XAG carry -> silver | XAU carry -> gold
# ZAR funding: 100% silver pre-23-Mar; 69.95% gold / 30.05% silver from 23-Mar
# Daily ZAR/USD rates from SWT ZAR-funding near-leg in [3]
# =============================================================================
_MAR_RATE = {
    '2026-03-18': 16.9622, '2026-03-19': 16.7583, '2026-03-20': 17.0995,
    '2026-03-23': 16.8257, '2026-03-24': 17.0504, '2026-03-25': 16.9417,
    '2026-03-26': 17.1557, '2026-03-27': 17.1292, '2026-03-30': 17.1772,
    '2026-03-31': 16.9586,
}
_GOLD_PCT = 0.6995

XAG_CARRY_MAR = [
    ('2026-03-18', 25.15), ('2026-03-19', 28.38), ('2026-03-20', 79.70),
    ('2026-03-23', 36.24), ('2026-03-24', 34.68), ('2026-03-25', 42.76),
    ('2026-03-26', 55.29), ('2026-03-27', 179.11),('2026-03-30', 63.39),
    ('2026-03-31', 70.54),
]
XAU_CARRY_MAR = [
    ('2026-03-25', 31.88), ('2026-03-26', 122.13), ('2026-03-27', 467.16),
    ('2026-03-30', 185.74), ('2026-03-31', 220.85),
]
ZAR_FUNDING_MAR = [
    ('2026-03-18', 19.58, 0.0),
    ('2026-03-19', 21.82, 0.0),
    ('2026-03-20', 64.15, 0.0),
    ('2026-03-23', 28.32, _GOLD_PCT),
    ('2026-03-24', 30.21, _GOLD_PCT),
    ('2026-03-25', 60.17, _GOLD_PCT),
    ('2026-03-26', 145.38, _GOLD_PCT),
    ('2026-03-27', 511.32, _GOLD_PCT),
    ('2026-03-30', 196.79, _GOLD_PCT),
    ('2026-03-31', 223.10, _GOLD_PCT),
]

print("\nInserting March 2026 swap fees...")

for date, usd_fee in XAG_CARRY_MAR:
    zar = -round(usd_fee * _MAR_RATE[date], 2)
    insert_funding_cost('SABIS', 'silver', 'Stone X', 'swap_fee', zar, date,
                        f'XAG/USD carry swap {date} -- ${usd_fee} x {_MAR_RATE[date]}')
    print(f"  Ag carry   {date}  ${usd_fee:6.2f} x {_MAR_RATE[date]}  = R{zar:>10,.2f}")

for date, usd_fee in XAU_CARRY_MAR:
    zar = -round(usd_fee * _MAR_RATE[date], 2)
    insert_funding_cost('SABIS', 'gold', 'Stone X', 'swap_fee', zar, date,
                        f'XAU/USD carry swap {date} -- ${usd_fee} x {_MAR_RATE[date]}')
    print(f"  Au carry   {date}  ${usd_fee:6.2f} x {_MAR_RATE[date]}  = R{zar:>10,.2f}")

for date, usd_fee, gold_pct in ZAR_FUNDING_MAR:
    zar_total = usd_fee * _MAR_RATE[date]
    silver_pct = 1.0 - gold_pct
    if gold_pct > 0:
        insert_funding_cost('SABIS', 'gold', 'Stone X', 'swap_fee',
                            -round(zar_total * gold_pct, 2), date,
                            f'ZAR funding swap {date} (gold {gold_pct*100:.0f}%)')
        insert_funding_cost('SABIS', 'silver', 'Stone X', 'swap_fee',
                            -round(zar_total * silver_pct, 2), date,
                            f'ZAR funding swap {date} (silver {silver_pct*100:.0f}%)')
    else:
        insert_funding_cost('SABIS', 'silver', 'Stone X', 'swap_fee',
                            -round(zar_total, 2), date,
                            f'ZAR funding swap {date} (100% silver pre-XAU)')
    print(f"  ZAR fund   {date}  ${usd_fee:6.2f}  Au {gold_pct*100:.0f}%  Ag {silver_pct*100:.0f}%")

# =============================================================================
# APRIL 2026 SWAP FEES
# XAG carry -> silver | XAU carry -> gold
# ZAR funding split by daily gold/silver proportion from SWT near-leg USD values
# Daily ZAR/USD rates from SWT ZAR-funding near-leg in [4]
# =============================================================================
_APR_RATE_DAY = {
    '2026-04-01': 16.8710200, '2026-04-02': 16.9341900, '2026-04-07': 16.8965900,
    '2026-04-08': 16.4393000, '2026-04-09': 16.3884200, '2026-04-10': 16.4079400,
    '2026-04-13': 16.3870900, '2026-04-14': 16.3509900, '2026-04-15': 16.3480300,
    '2026-04-16': 16.4148900, '2026-04-17': 16.2788900,
}

# Gold % of total USD position by day (XAU near / (XAU near + XAG near))
_APR_GOLD_PCT = {
    '2026-04-01': 1_663_523.75 / (1_663_523.75 + 646_879.10),   # 72.03%
    '2026-04-02': 1_685_337.53 / (1_685_337.53 + 687_976.91),   # 71.00%
    '2026-04-07': 1_827_417.76 / (1_827_417.76 + 728_500.87),   # 71.51%
    '2026-04-08': 1_849_243.82 / (1_849_243.82 + 773_946.53),   # 70.49%
    '2026-04-09': 1_875_464.78 / (1_875_464.78 + 796_529.56),   # 70.19%
    '2026-04-10': 1_873_163.76 / (1_873_163.76 + 810_960.55),   # 69.78%
    '2026-04-13': 1_956_944.75 / (1_956_944.75 + 801_192.38),   # 70.96%
    '2026-04-14': 1_745_566.77 / (1_745_566.77 + 873_118.70),   # 66.67%
    '2026-04-15': 1_732_810.83 / (1_732_810.83 + 874_274.78),   # 66.47%
    '2026-04-16': 1_125_309.25 / (1_125_309.25 + 269_280.97),   # 80.70%
    '2026-04-17': 1_185_676.52 / (1_185_676.52 + 284_797.04),   # 80.63%
}

# XAU carry costs (USD, from SWT far-near difference)
XAU_CARRY_APR = [
    ('2026-04-01',   225.05), ('2026-04-02', 1_140.03), ('2026-04-07',   247.35),
    ('2026-04-08',   250.34), ('2026-04-09',   253.87), ('2026-04-10',   760.06),
    ('2026-04-13',   264.73), ('2026-04-14',   236.09), ('2026-04-15',   234.29),
    ('2026-04-16',   152.28), ('2026-04-17',   481.17),
]

# XAG carry costs (USD)
XAG_CARRY_APR = [
    ('2026-04-01',  91.07), ('2026-04-02', 484.47), ('2026-04-07', 102.56),
    ('2026-04-08', 109.01), ('2026-04-09', 112.16), ('2026-04-10', 342.62),
    ('2026-04-13', 112.82), ('2026-04-14', 122.93), ('2026-04-15', 123.15),
    ('2026-04-16',  37.91), ('2026-04-17', 120.34),
]

# ZAR funding net receipts (USD, positive = SA Bullion receives)
ZAR_FUNDING_APR = [
    ('2026-04-01',  226.04), ('2026-04-02', 1_184.00), ('2026-04-07',  258.27),
    ('2026-04-08',  268.26), ('2026-04-09',   268.97), ('2026-04-10',  808.36),
    ('2026-04-13',  279.60), ('2026-04-14',   257.96), ('2026-04-15',  257.91),
    ('2026-04-16',  134.84), ('2026-04-17',   422.74),
]

print("\nInserting April 2026 swap fees...")

for date, usd_fee in XAU_CARRY_APR:
    zar = -round(usd_fee * _APR_RATE_DAY[date], 2)
    insert_funding_cost('SABIS', 'gold', 'Stone X', 'swap_fee', zar, date,
                        f'XAU/USD carry swap {date} -- ${usd_fee} x {_APR_RATE_DAY[date]}')
    print(f"  Au carry   {date}  ${usd_fee:7.2f} x {_APR_RATE_DAY[date]}  = R{zar:>12,.2f}")

for date, usd_fee in XAG_CARRY_APR:
    zar = -round(usd_fee * _APR_RATE_DAY[date], 2)
    insert_funding_cost('SABIS', 'silver', 'Stone X', 'swap_fee', zar, date,
                        f'XAG/USD carry swap {date} -- ${usd_fee} x {_APR_RATE_DAY[date]}')
    print(f"  Ag carry   {date}  ${usd_fee:7.2f} x {_APR_RATE_DAY[date]}  = R{zar:>12,.2f}")

for date, usd_receipt in ZAR_FUNDING_APR:
    zar_total = usd_receipt * _APR_RATE_DAY[date]
    gp = _APR_GOLD_PCT[date]
    sp = 1.0 - gp
    insert_funding_cost('SABIS', 'gold', 'Stone X', 'swap_fee',
                        -round(zar_total * gp, 2), date,
                        f'ZAR funding swap {date} (gold {gp*100:.1f}%)')
    insert_funding_cost('SABIS', 'silver', 'Stone X', 'swap_fee',
                        -round(zar_total * sp, 2), date,
                        f'ZAR funding swap {date} (silver {sp*100:.1f}%)')
    print(f"  ZAR fund   {date}  ${usd_receipt:7.2f}  Au {gp*100:.1f}%  Ag {sp*100:.1f}%")

# =============================================================================
# INTEREST EARNED (EJV) -- 90-day period [4]
# 15 entries 13-Mar to 17-Apr, USD 529.34 total.
# Allocated: gold 80.63% / silver 19.37% (by April close USD position value).
# Converted at April derived rate 16.2917 ZAR/USD.
# =============================================================================
_GOLD_INT_PCT   = (244 * 4_859.33) / ((244 * 4_859.33) + (3_492 * 81.557))
_SILVER_INT_PCT = 1.0 - _GOLD_INT_PCT

EJV = [
    ('2026-03-13', 19.15), ('2026-03-16', 25.65), ('2026-03-19', 24.79),
    ('2026-03-23', 17.91), ('2026-03-24', 59.21), ('2026-03-26', 15.82),
    ('2026-03-30', 14.91), ('2026-04-01',  9.31), ('2026-04-02', 12.14),
    ('2026-04-06', 49.89), ('2026-04-08', 13.46), ('2026-04-09', 46.76),
    ('2026-04-13', 44.54), ('2026-04-15', 42.95), ('2026-04-17', 132.85),
]

print(f"\nInserting {len(EJV)} EJV interest entries "
      f"(USD {sum(e[1] for e in EJV):.2f} total)...")
note = 'EJV interest on USD cash balance -- StoneX MT0795'
for date, usd_amt in EJV:
    au = round(usd_amt * _APR_RATE * _GOLD_INT_PCT,   2)
    ag = round(usd_amt * _APR_RATE * _SILVER_INT_PCT, 2)
    insert_funding_cost('SABIS', 'gold',   'Stone X', 'interest_earned', au, date, note)
    insert_funding_cost('SABIS', 'silver', 'Stone X', 'interest_earned', ag, date, note)
    print(f"  {date}  USD{usd_amt:6.2f}  -> Au R{au:7.2f}  Ag R{ag:6.2f}")

# -- Verification --------------------------------------------------------------
print("\n--- Verification ---")
conn = get_conn()
c = conn.cursor()

print("Physical base:")
for r in c.execute("SELECT entity, metal, total_oz FROM inventory WHERE entity='SABIS'"):
    print(f"  {r[0]} {r[1]:6}: {r[2]:,.3f} oz")

print("\nHedging (by metal / position type):")
for r in c.execute("""
    SELECT metal, position_type,
           COUNT(*) lots, SUM(contract_oz) oz,
           SUM(contract_oz * open_price_zar) / SUM(contract_oz) vwap
    FROM hedging WHERE entity='SABIS' AND platform='Stone X' AND status='open'
    GROUP BY metal, position_type ORDER BY metal, position_type
"""):
    print(f"  {r[0]:<6} {r[1]:<5} {r[2]:2} lots  {r[3]:>9,.0f} oz  @ R{r[4]:>10,.2f} VWAP")

print("\nFunding costs (Stone X):")
for r in c.execute("""
    SELECT metal, cost_type, COUNT(*) n, SUM(amount_zar) total
    FROM funding_costs WHERE entity='SABIS' AND platform='Stone X'
    GROUP BY metal, cost_type ORDER BY metal, cost_type
"""):
    print(f"  {r[0]:<6} {r[1]:<16} {r[2]:>2} entries  R{r[3]:>12,.2f}")

conn.close()
print("\nDone. Restart Flask server to pick up the new positions.")
