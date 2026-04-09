"""
Treasury Brain — Excel Importer
Reads dealer Excel sheets, validates, maps columns, and feeds the processor.
"""

import os
import shutil
import json
from datetime import datetime, date

import pandas as pd

from processor import (
    get_provision_mode, live_impact_preview,
    calc_gp_contribution, margin_vs_provision
)
from models import (
    get_inventory, get_latest_spot, insert_deal,
    update_inventory, insert_cash_flow
)

CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'settings.json')
with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

INBOX     = os.path.join(os.path.dirname(__file__), '..', CONFIG['inbox_folder'])
PROCESSED = os.path.join(os.path.dirname(__file__), '..', CONFIG['processed_folder'])
ERRORS    = os.path.join(os.path.dirname(__file__), '..', CONFIG['errors_folder'])

# ─────────────────────────────────────────────
# COLUMN MAP
# Maps expected internal column names → possible dealer column names (case-insensitive)
# ─────────────────────────────────────────────
COLUMN_MAP = {
    'deal_type':      ['type', 'deal type', 'buy/sell', 'transaction type'],
    'deal_date':      ['date', 'deal date', 'transaction date'],
    'entity':         ['entity', 'company'],
    'metal':          ['metal', 'commodity', 'asset'],
    'silo':           ['silo', 'channel type', 'client type'],
    'channel':        ['channel', 'source', 'platform'],
    'dealer_name':    ['dealer', 'dealer name', 'rep', 'representative'],
    'product_code':   ['product code', 'code', 'sku'],
    'product_name':   ['product', 'product name', 'item'],
    'units':          ['units', 'qty', 'quantity'],
    'equiv_oz':       ['equivalent oz', 'oz per unit', 'equiv oz'],
    'spot_price_zar': ['spot', 'spot price', 'spot zar', 'gold spot', 'silver spot'],
    'margin_pct':     ['margin', 'margin %', 'margin pct', '% over spot', '% under spot'],
    'client_name':    ['client', 'client name', 'customer'],
}


def _map_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise column names from dealer sheet to internal schema."""
    rename = {}
    lower_cols = {c.lower().strip(): c for c in df.columns}
    for internal, variants in COLUMN_MAP.items():
        for v in variants:
            if v.lower() in lower_cols:
                rename[lower_cols[v.lower()]] = internal
                break
    return df.rename(columns=rename)


def _validate_row(row: dict, row_num: int) -> list:
    """Returns list of error strings for a single deal row."""
    errors = []
    required = ['deal_type', 'deal_date', 'entity', 'metal', 'silo',
                'channel', 'units', 'spot_price_zar', 'margin_pct']
    for field in required:
        if field not in row or pd.isna(row.get(field)):
            errors.append(f"Row {row_num}: missing required field '{field}'")

    if 'deal_type' in row and str(row['deal_type']).lower() not in ('buy', 'sell'):
        errors.append(f"Row {row_num}: deal_type must be 'buy' or 'sell'")

    if 'entity' in row and str(row['entity']).upper() not in ('SABIS', 'SABI', 'SABGB'):
        errors.append(f"Row {row_num}: entity must be SABIS, SABI or SABGB")

    if 'metal' in row and str(row['metal']).lower() not in ('gold', 'silver'):
        errors.append(f"Row {row_num}: metal must be 'gold' or 'silver'")

    if 'silo' in row and str(row['silo']).lower() not in ('retail', 'wholesale', 'custody'):
        errors.append(f"Row {row_num}: silo must be retail, wholesale or custody")

    if 'channel' in row and str(row['channel']).lower() not in ('digital', 'dealer'):
        errors.append(f"Row {row_num}: channel must be 'digital' or 'dealer'")

    return errors


def process_file(filepath: str) -> dict:
    """
    Main entry point. Reads, validates, and processes a dealer Excel file.
    Returns summary of what was imported.
    """
    filename = os.path.basename(filepath)
    print(f"\n📂 Processing: {filename}")

    try:
        df = pd.read_excel(filepath, dtype=str)
    except Exception as e:
        _move_to_errors(filepath, str(e))
        return {'status': 'error', 'file': filename, 'error': str(e)}

    df = _map_columns(df)
    all_errors = []
    processed_deals = []

    for i, row in df.iterrows():
        row_dict = row.to_dict()
        row_errors = _validate_row(row_dict, i + 2)  # +2 for header row + 1-indexed
        if row_errors:
            all_errors.extend(row_errors)
            continue

        try:
            deal_result = _process_row(row_dict, filename)
            if deal_result:
                processed_deals.append(deal_result)
        except Exception as e:
            all_errors.append(f"Row {i+2}: processing error — {e}")

    if all_errors and not processed_deals:
        _move_to_errors(filepath, '\n'.join(all_errors))
        return {'status': 'error', 'file': filename, 'errors': all_errors}

    _move_to_processed(filepath)

    result = {
        'status':          'success' if not all_errors else 'partial',
        'file':            filename,
        'deals_imported':  len(processed_deals),
        'warnings':        all_errors,
        'deals':           processed_deals,
    }
    print(f"✅ Imported {len(processed_deals)} deals. Warnings: {len(all_errors)}")
    return result


def _process_row(row: dict, source_file: str) -> dict:
    """Process a single validated deal row."""
    entity     = str(row['entity']).upper()
    metal      = str(row['metal']).lower()
    deal_type  = str(row['deal_type']).lower()
    silo       = str(row['silo']).lower()
    channel    = str(row['channel']).lower()
    units      = float(row['units'])
    spot       = float(row['spot_price_zar'])
    margin_pct = float(row['margin_pct'])

    equiv_oz   = float(row.get('equiv_oz', 1.0) or 1.0)
    oz         = equiv_oz * units

    deal_date  = str(row.get('deal_date', date.today().isoformat()))[:10]

    # Get current state from DB
    current_inventory = get_inventory(entity, metal)

    # Get provision
    provision = get_provision_mode(current_inventory, metal)
    provision_pct = provision['rate_pct']

    # Effective price and deal value
    effective_price = spot * (1 + margin_pct / 100)
    deal_value      = effective_price * oz

    # Margin vs provision
    mvp    = margin_vs_provision(margin_pct, provision_pct, deal_type)
    gp     = calc_gp_contribution(mvp['profit_pct'], deal_value)

    # Inventory delta
    inv_delta     = oz if deal_type == 'buy' else -oz
    new_inventory = current_inventory + inv_delta
    flipped       = (current_inventory >= 0 and new_inventory < 0) or \
                    (current_inventory < 0  and new_inventory >= 0)

    # Build deal record
    deal_record = {
        'entity':             entity,
        'metal':              metal,
        'deal_type':          deal_type,
        'deal_date':          deal_date,
        'dealer_name':        str(row.get('dealer_name', '')),
        'silo':               silo,
        'channel':            channel,
        'product_code':       str(row.get('product_code', '')),
        'product_name':       str(row.get('product_name', '')),
        'equiv_oz_per_unit':  equiv_oz,
        'units':              units,
        'oz':                 oz,
        'spot_price_zar':     spot,
        'margin_pct':         margin_pct,
        'effective_price_zar': effective_price,
        'deal_value_zar':     deal_value,
        'provision_pct':      provision_pct,
        'profit_margin_pct':  mvp['profit_pct'],
        'gp_contribution_zar': gp,
        'inventory_after_oz': new_inventory,
        'provision_flipped':  1 if flipped else 0,
        'source_file':        source_file,
    }

    # Write to DB
    deal_id = insert_deal(deal_record)

    # Update inventory
    update_inventory(entity, metal, inv_delta)

    # Record cash flow
    insert_cash_flow({
        'entity':      entity,
        'flow_date':   deal_date,
        'flow_type':   'deal',
        'direction':   'in' if deal_type == 'sell' else 'out',
        'amount_zar':  deal_value,
        'description': f"{deal_type.title()} {oz:.4f}oz {metal} @ {spot} spot {margin_pct:+.2f}%",
        'deal_id':     deal_id,
    })

    deal_record['deal_id'] = deal_id
    return deal_record


def _move_to_processed(filepath: str):
    dest = os.path.join(PROCESSED, os.path.basename(filepath))
    shutil.move(filepath, dest)
    print(f"  → Moved to processed: {dest}")


def _move_to_errors(filepath: str, reason: str):
    dest = os.path.join(ERRORS, os.path.basename(filepath))
    shutil.move(filepath, dest)
    error_log = dest + '.error.txt'
    with open(error_log, 'w') as f:
        f.write(reason)
    print(f"  ✗ Moved to errors: {dest}\n    Reason: {reason}")
