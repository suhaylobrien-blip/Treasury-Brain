"""
Treasury Brain — Startup Data Loader

Runs automatically when start.bat launches.  Checks whether deals exist in the
database; if the table is empty it re-imports all source sheets from data/source/
and applies the end-of-day position reconciliation.

This means the dashboard is always ready without manual uploads.
"""
import os
import sys
import sqlite3

_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _DIR)

from models import DB_PATH, init_db, get_conn, set_inventory_position

# Folder containing the reference dealing sheets
SOURCE_DIR = os.path.join(_DIR, '..', 'data', 'source')

# Known end-of-day positions — update these after each reconciliation
EOD_POSITIONS = {
    ('SABIS', 'gold'):   -500.15,
    ('SABIS', 'silver'): -17722.89,
}


def _deal_count() -> int:
    try:
        conn = sqlite3.connect(DB_PATH)
        c    = conn.execute("SELECT COUNT(*) FROM deals")
        n    = c.fetchone()[0]
        conn.close()
        return n
    except Exception:
        return 0


def _import_sources():
    """Import every .xlsx / .xlsm file in data/source/ into SABIS."""
    from importer import process_file

    xlsx_files = [
        f for f in os.listdir(SOURCE_DIR)
        if f.lower().endswith(('.xlsx', '.xlsm', '.xls'))
    ]

    if not xlsx_files:
        print("[startup] No source sheets found in data/source/ — skipping auto-import.")
        return 0

    total = 0
    for fname in sorted(xlsx_files):
        path   = os.path.join(SOURCE_DIR, fname)
        print(f"[startup] Importing: {fname}")
        result = process_file(path, entity='SABIS', display_name=fname)
        n      = result.get('deals_imported', 0)
        total += n
        print(f"[startup]   -> {n} deals  (breakdown: {result.get('metal_breakdown', {})})")
        if result.get('warnings'):
            print(f"[startup]   warnings: {len(result['warnings'])}")

    return total


def _apply_eod_positions():
    """Set the reconciled end-of-day physical inventory positions."""
    for (entity, metal), oz in EOD_POSITIONS.items():
        set_inventory_position(entity, metal, oz)
        print(f"[startup] EOD position: {entity} {metal} = {oz:,.2f} oz")


def run():
    init_db()
    os.makedirs(SOURCE_DIR, exist_ok=True)

    n = _deal_count()
    if n > 0:
        print(f"[startup] Database has {n} deals — no import needed.")
        return

    print("[startup] Database is empty — auto-importing source sheets...")
    imported = _import_sources()

    if imported > 0:
        print("[startup] Applying end-of-day position reconciliation...")
        _apply_eod_positions()
        print(f"[startup] Ready. {imported} deals loaded.")
    else:
        print("[startup] No deals imported — upload a sheet via the dashboard.")


if __name__ == '__main__':
    run()
