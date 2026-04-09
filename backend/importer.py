"""
Treasury Brain — Excel Importer
Reads dealer Excel sheets, validates, maps columns, and feeds the processor.
Supports the SABIS dealing sheet format (split left/right columns, multi-tab).
"""

import os
import shutil
import json
from datetime import datetime, date

import pandas as pd
from openpyxl import load_workbook

from processor import (
    get_provision_mode,
    calc_gp_contribution, margin_vs_provision
)
from models import (
    get_inventory, get_latest_spot, insert_deal,
    update_inventory, insert_cash_flow
)

CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'settings.json')
with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

INBOX     = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', CONFIG['inbox_folder']))
PROCESSED = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', CONFIG['processed_folder']))
ERRORS    = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', CONFIG['errors_folder']))

os.makedirs(INBOX,     exist_ok=True)
os.makedirs(PROCESSED, exist_ok=True)
os.makedirs(ERRORS,    exist_ok=True)

# ─────────────────────────────────────────────
# SABIS DEALING SHEET — TAB DETECTION
# ─────────────────────────────────────────────

# Keywords that identify a tab as containing deal data
DEAL_TAB_KEYWORDS = ['dealing', 'bullion', 'gold excl']
SKIP_TAB_KEYWORDS = ['mastersheet', 'tables', 'data', 'mt only']


def _is_deal_tab(name: str) -> bool:
    n = name.lower()
    if any(skip in n for skip in SKIP_TAB_KEYWORDS):
        return False
    return any(kw in n for kw in DEAL_TAB_KEYWORDS)


def _metal_from_tab(name: str) -> str:
    n = name.lower()
    if 'silver' in n:
        return 'silver'
    return 'gold'  # KR, Gold Excl KRs, etc.


# ─────────────────────────────────────────────
# COLUMN MAPPING — SABIS DEALING SHEET FORMAT
# ─────────────────────────────────────────────

# Maps internal field names to possible column headers (case-insensitive strip)
SABIS_COL_MAP = {
    'deal_date':      ['date'],
    'client_name':    ['client name'],
    'channel_raw':    ['source channel'],
    'product_name':   ['product name'],
    'product_code':   ['product code'],
    'movement':       ['inventory movement', 'inventory movement '],
    'units':          ['quantity'],
    'equiv_oz':       ['uom'],
    'oz':             ['total ounces'],
    'spot_price_zar': ['spot price'],
    'margin_pct':     ['margin'],
    'deal_value_zar': ['total price', 'total price '],
}


def _map_sabis_cols(df: pd.DataFrame) -> pd.DataFrame:
    """Rename columns from dealer sheet to internal names."""
    rename = {}
    lower_cols = {c.lower().strip(): c for c in df.columns}
    for internal, variants in SABIS_COL_MAP.items():
        for v in variants:
            if v.lower() in lower_cols:
                rename[lower_cols[v.lower()]] = internal
                break
    return df.rename(columns=rename)


# ─────────────────────────────────────────────
# SABIS FIELD INTERPRETATION
# ─────────────────────────────────────────────

def _deal_type_from_movement(movement: str) -> str:
    """'Buyback*' → buy, everything else → sell."""
    if pd.isna(movement):
        return 'sell'
    return 'buy' if 'buyback' in str(movement).lower() else 'sell'


def _channel_from_source(source: str) -> str:
    """MT → dealer, Goldstore/Treasury/etc → digital."""
    if pd.isna(source):
        return 'dealer'
    s = str(source).strip().lower()
    if s == 'mt':
        return 'dealer'
    return 'digital'


def _silo_from_movement(movement: str) -> str:
    """Vault → custody, else retail."""
    if pd.isna(movement):
        return 'retail'
    if 'vault' in str(movement).lower():
        return 'custody'
    return 'retail'


# ─────────────────────────────────────────────
# PARSE ONE HALF (left or right) OF A DEALING SHEET
# ─────────────────────────────────────────────

def _extract_half(df: pd.DataFrame, suffix: str = '') -> pd.DataFrame:
    """
    The dealing sheet has two sets of deals side by side.
    Left half: standard column names.
    Right half: same names with '.1' suffix appended by pandas.
    Returns a cleaned DataFrame for one half.
    """
    if suffix:
        # Select only columns that end with the suffix
        cols = {c: c[:-len(suffix)] for c in df.columns if c.endswith(suffix)}
        half = df[list(cols.keys())].rename(columns=cols)
    else:
        # Left half: columns that do NOT end with '.1'
        cols = [c for c in df.columns if not c.endswith('.1')]
        half = df[cols].copy()

    return half


def _parse_deal_tab(df: pd.DataFrame, metal: str, entity: str,
                    source_file: str) -> list:
    """
    Parse all deals from a single sheet tab (one half at a time).
    Left half (no suffix) = BUYBACKS (buys).
    Right half (.1 suffix) = SALES (sells).
    Returns list of normalised deal dicts ready for _process_row.
    """
    deals = []

    # Left = buy, Right = sell — determined by position, not text content
    side_deal_type = {'': 'buy', '.1': 'sell'}

    for suffix in ['', '.1']:
        half = _extract_half(df, suffix)
        half = _map_sabis_cols(half)
        deal_type = side_deal_type[suffix]

        # Keep only rows that have a spot price (actual deal rows)
        if 'spot_price_zar' not in half.columns:
            continue

        # Forward-fill dates (date only appears on first row of each group)
        if 'deal_date' in half.columns:
            half['deal_date'] = half['deal_date'].ffill()

        for _, row in half.iterrows():
            # Skip rows with no spot price or no units
            try:
                spot  = float(row.get('spot_price_zar', ''))
                units = float(row.get('units', ''))
                equiv = float(row.get('equiv_oz', 1.0) or 1.0)
            except (ValueError, TypeError):
                continue

            if spot == 0 or units == 0:
                continue

            # Margin — handle % expressed as decimal (e.g. 0.115 = 11.5%)
            try:
                margin = float(row.get('margin_pct', 0) or 0)
                # If margin looks like a decimal proportion rather than percent
                if -1 < margin < 1 and margin != 0:
                    margin = margin * 100
            except (ValueError, TypeError):
                margin = 0.0

            # Deal date
            raw_date = row.get('deal_date')
            if pd.isna(raw_date) or raw_date == '' or raw_date is None:
                deal_date = date.today().isoformat()
            else:
                try:
                    deal_date = pd.to_datetime(raw_date).date().isoformat()
                except Exception:
                    deal_date = date.today().isoformat()

            movement = str(row.get('movement', '') or '')
            source   = str(row.get('channel_raw', '') or '')

            deals.append({
                'entity':        entity,
                'metal':         metal,
                'deal_type':     deal_type,   # left=buy, right=sell
                'deal_date':     deal_date,
                'client_name':   str(row.get('client_name', '') or ''),
                'silo':          _silo_from_movement(movement),
                'channel':       _channel_from_source(source),
                'product_code':  str(row.get('product_code', '') or ''),
                'product_name':  str(row.get('product_name', '') or ''),
                'units':         units,
                'equiv_oz':      equiv,
                'spot_price_zar': spot,
                'margin_pct':    margin,
                'source_file':   source_file,
            })

    return deals


# ─────────────────────────────────────────────
# MAIN ENTRY POINT
# ─────────────────────────────────────────────

def _get_sheet_names(filepath: str) -> list:
    """Fast sheet name extraction using zipfile (no formula parsing)."""
    import zipfile
    import xml.etree.ElementTree as ET
    try:
        with zipfile.ZipFile(filepath) as z:
            with z.open('xl/workbook.xml') as f:
                tree = ET.parse(f)
                ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                sheets = tree.findall('.//ns:sheet', ns)
                return [s.get('name', '') for s in sheets]
    except Exception:
        # Fallback to openpyxl
        wb = load_workbook(filepath, read_only=True)
        names = wb.sheetnames
        wb.close()
        return names


def process_file(filepath: str, entity: str = 'SABIS') -> dict:
    """
    Main entry point. Reads, validates, and processes a dealer Excel file.
    Auto-detects SABIS dealing sheet format vs generic format.
    Returns summary of what was imported.
    """
    import tempfile, warnings
    warnings.filterwarnings('ignore', category=UserWarning)

    filename = os.path.basename(filepath)
    print(f"\nProcessing: {filename}")

    # Copy to local temp to avoid OneDrive/network sync locks during processing
    tmp_path = os.path.join(tempfile.gettempdir(), filename)
    try:
        shutil.copy2(filepath, tmp_path)
    except Exception as e:
        _move_to_errors(filepath, f"Could not read file: {e}")
        return {'status': 'error', 'file': filename, 'error': str(e)}

    try:
        sheet_names = _get_sheet_names(tmp_path)
    except Exception as e:
        _move_to_errors(filepath, str(e))
        return {'status': 'error', 'file': filename, 'error': str(e)}

    # Detect SABIS dealing sheet by checking tab names
    deal_tabs = [s for s in sheet_names if _is_deal_tab(s)]

    if deal_tabs:
        return _process_sabis_file(filepath, filename, deal_tabs, entity, tmp_path)
    else:
        return _process_generic_file(filepath, filename, tmp_path)


def _process_sabis_file(filepath: str, filename: str,
                        deal_tabs: list, entity: str,
                        read_from: str = None) -> dict:
    """Process an SABIS-format dealing workbook (multi-tab, split columns)."""
    src = read_from or filepath
    all_errors    = []
    processed_deals = []

    for tab in deal_tabs:
        metal = _metal_from_tab(tab)
        print(f"  Reading tab: '{tab}' -> metal={metal}")

        try:
            df = pd.read_excel(src, sheet_name=tab, dtype=str, header=0,
                               engine='openpyxl')
        except Exception as e:
            all_errors.append(f"Tab '{tab}': could not read — {e}")
            continue

        deals = _parse_deal_tab(df, metal, entity, filename)
        print(f"    Found {len(deals)} deal rows")

        for deal in deals:
            try:
                result = _process_row(deal, filename)
                if result:
                    processed_deals.append(result)
            except Exception as e:
                all_errors.append(f"Tab '{tab}': row error — {e}")

    if not processed_deals:
        _move_to_errors(filepath, '\n'.join(all_errors) if all_errors
                        else 'No valid deal rows found in any tab.')
        return {'status': 'error', 'file': filename, 'errors': all_errors}

    _move_to_processed(filepath)
    print(f"✅ Imported {len(processed_deals)} deals. Warnings: {len(all_errors)}")
    return {
        'status':         'success' if not all_errors else 'partial',
        'file':           filename,
        'deals_imported': len(processed_deals),
        'warnings':       all_errors,
        'deals':          processed_deals,
    }


# ─────────────────────────────────────────────
# GENERIC FORMAT (original column-map approach)
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
    'equiv_oz':       ['equivalent oz', 'oz per unit', 'equiv oz', 'uom'],
    'spot_price_zar': ['spot', 'spot price', 'spot zar', 'gold spot', 'silver spot'],
    'margin_pct':     ['margin', 'margin %', 'margin pct', '% over spot', '% under spot'],
    'client_name':    ['client', 'client name', 'customer'],
}


def _map_columns(df: pd.DataFrame) -> pd.DataFrame:
    rename = {}
    lower_cols = {c.lower().strip(): c for c in df.columns}
    for internal, variants in COLUMN_MAP.items():
        for v in variants:
            if v.lower() in lower_cols:
                rename[lower_cols[v.lower()]] = internal
                break
    return df.rename(columns=rename)


def _validate_row(row: dict, row_num: int) -> list:
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


def _process_generic_file(filepath: str, filename: str,
                          read_from: str = None) -> dict:
    src = read_from or filepath
    try:
        df = pd.read_excel(src, dtype=str)
    except Exception as e:
        _move_to_errors(filepath, str(e))
        return {'status': 'error', 'file': filename, 'error': str(e)}

    df = _map_columns(df)
    all_errors = []
    processed_deals = []

    for i, row in df.iterrows():
        row_dict = row.to_dict()
        row_errors = _validate_row(row_dict, i + 2)
        if row_errors:
            all_errors.extend(row_errors)
            continue
        try:
            result = _process_row(row_dict, filename)
            if result:
                processed_deals.append(result)
        except Exception as e:
            all_errors.append(f"Row {i+2}: processing error — {e}")

    if all_errors and not processed_deals:
        _move_to_errors(filepath, '\n'.join(all_errors))
        return {'status': 'error', 'file': filename, 'errors': all_errors}

    _move_to_processed(filepath)
    print(f"✅ Imported {len(processed_deals)} deals. Warnings: {len(all_errors)}")
    return {
        'status':         'success' if not all_errors else 'partial',
        'file':           filename,
        'deals_imported': len(processed_deals),
        'warnings':       all_errors,
        'deals':          processed_deals,
    }


# ─────────────────────────────────────────────
# PROCESS A SINGLE DEAL ROW → DB
# ─────────────────────────────────────────────

def _process_row(row: dict, source_file: str) -> dict:
    """Calculate all fields and write a single deal to the database."""
    entity     = str(row['entity']).upper()
    metal      = str(row['metal']).lower()
    deal_type  = str(row['deal_type']).lower()
    silo       = str(row['silo']).lower()
    channel    = str(row['channel']).lower()
    units      = float(row['units'])
    spot       = float(row['spot_price_zar'])
    margin_pct = float(row['margin_pct'])

    equiv_oz  = float(row.get('equiv_oz', 1.0) or 1.0)
    oz        = equiv_oz * units

    deal_date = str(row.get('deal_date', date.today().isoformat()))[:10]

    current_inventory = get_inventory(entity, metal)
    provision         = get_provision_mode(current_inventory, metal)
    provision_pct     = provision['rate_pct']

    effective_price = spot * (1 + margin_pct / 100)
    deal_value      = effective_price * oz

    mvp = margin_vs_provision(margin_pct, provision_pct, deal_type)
    gp  = calc_gp_contribution(mvp['profit_pct'], deal_value)

    inv_delta     = oz if deal_type == 'buy' else -oz
    new_inventory = current_inventory + inv_delta
    flipped       = (current_inventory >= 0 and new_inventory < 0) or \
                    (current_inventory < 0  and new_inventory >= 0)

    deal_record = {
        'entity':              entity,
        'metal':               metal,
        'deal_type':           deal_type,
        'deal_date':           deal_date,
        'dealer_name':         str(row.get('dealer_name', row.get('client_name', ''))),
        'silo':                silo,
        'channel':             channel,
        'product_code':        str(row.get('product_code', '')),
        'product_name':        str(row.get('product_name', '')),
        'equiv_oz_per_unit':   equiv_oz,
        'units':               units,
        'oz':                  oz,
        'spot_price_zar':      spot,
        'margin_pct':          margin_pct,
        'effective_price_zar': effective_price,
        'deal_value_zar':      deal_value,
        'provision_pct':       provision_pct,
        'profit_margin_pct':   mvp['profit_pct'],
        'gp_contribution_zar': gp,
        'inventory_after_oz':  new_inventory,
        'provision_flipped':   1 if flipped else 0,
        'source_file':         source_file,
    }

    deal_id = insert_deal(deal_record)
    update_inventory(entity, metal, inv_delta)
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


# ─────────────────────────────────────────────
# FILE MANAGEMENT
# ─────────────────────────────────────────────

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
    print(f"  ✗ Moved to errors: {dest}\n    Reason logged.")
