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
    get_inventory, get_latest_spot, insert_deal, insert_pipeline,
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

# Tabs to always ignore regardless of other keywords
SKIP_TAB_KEYWORDS = [
    'mastersheet', 'tables', 'data', 'mt only', 'summary',
    'prices', 'spot', 'settings', 'config', 'pivot', 'index',
    'ref', 'rates', 'holiday', 'calendar',
]

# Keywords that confirm a tab contains deal data
DEAL_TAB_KEYWORDS = [
    'dealing', 'bullion', 'gold', 'silver', 'bar', 'coin', 'kr',
]


def _is_deal_tab(name: str) -> bool:
    n = name.lower().strip()
    if any(skip in n for skip in SKIP_TAB_KEYWORDS):
        return False
    return any(kw in n for kw in DEAL_TAB_KEYWORDS)


def _metal_from_tab(name: str) -> str:
    """
    Silver / SKR tabs → silver.
    KR, Gold bullion, gold bars, gold coins → gold.
    """
    n = name.lower().strip()
    # Silver Krugerrand or any silver tab
    if 'silver' in n or n.startswith('skr'):
        return 'silver'
    return 'gold'


# ─────────────────────────────────────────────
# ROW COLOUR CLASSIFICATION
# ─────────────────────────────────────────────

def _get_cell_rgb(cell) -> str:
    """Return RRGGBB hex string from a cell's solid fill, or '' if none."""
    try:
        fill = cell.fill
        if not fill or fill.fill_type != 'solid':
            return ''
        fc = fill.fgColor
        if fc.type == 'rgb':
            return fc.rgb[-6:]        # last 6 of AARRGGBB
        if fc.type == 'indexed' and fc.indexed not in (0, 64, 65):
            # index 64/65 = no fill; 0 = black — skip those
            return ''
    except Exception:
        pass
    return ''


def _classify_rgb(rgb6: str) -> str:
    """
    Classify a 6-char hex colour (RRGGBB) into deal status.

    Orange → 'confirmed'  (standard confirmed bullion/coin deal)
    Yellow → 'quote'      (pipeline — not yet confirmed)
    Blue   → 'proof'      (proof coin deal — track separately)
    White / empty → ''    (no colour → skip / header row)
    Other  → 'confirmed'  (any other colour = treat as confirmed)
    """
    if not rgb6 or len(rgb6) < 6:
        return ''
    try:
        r = int(rgb6[0:2], 16)
        g = int(rgb6[2:4], 16)
        b = int(rgb6[4:6], 16)
    except ValueError:
        return ''

    # Near-white → no colour (skip)
    if r > 240 and g > 240 and b > 240:
        return ''
    # Near-black → skip
    if r < 20 and g < 20 and b < 20:
        return ''

    # Blue: dominant blue channel (proof coins)
    if b > 130 and b > r + 40:
        return 'proof'

    # Yellow: high R + high G, low B  (quote / pipeline)
    if r > 180 and g > 180 and b < 100:
        return 'quote'

    # Orange: high R, mid G, low B  (confirmed bullion)
    if r > 180 and 60 <= g <= 200 and b < 80:
        return 'confirmed'

    # Anything else → treat as confirmed
    return 'confirmed'


def _read_row_statuses(workbook_path: str, sheet_name: str) -> dict:
    """
    Opens workbook with openpyxl (full mode, not read_only) and reads
    the fill colour of the first non-empty cell in each row.
    Returns {excel_row_number: status_string}.
    status_string: 'confirmed' | 'quote' | 'proof' | ''
    """
    from openpyxl import load_workbook
    import warnings
    warnings.filterwarnings('ignore')
    wb = None
    try:
        wb = load_workbook(workbook_path, data_only=True)
        ws = wb[sheet_name]
        statuses = {}
        for row in ws.iter_rows():
            row_num = row[0].row
            status  = ''
            for cell in row:
                rgb = _get_cell_rgb(cell)
                s   = _classify_rgb(rgb)
                if s:
                    status = s
                    break
            statuses[row_num] = status
        return statuses
    except Exception as e:
        print(f"    [colour] Could not read colours from '{sheet_name}': {e}")
        return {}
    finally:
        if wb:
            try:
                wb.close()
            except Exception:
                pass


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


# Known digital platforms — anything else in Source Channel is a dealer name
DIGITAL_PLATFORMS = {
    'goldstore', 'gold store', 'web', 'app', 'online',
    'digital', 'website', 'portal',
}


def _channel_from_source(source: str) -> str:
    """Digital platforms → 'digital'.  Named dealers (MT, Nate, Grant, etc.) → 'dealer'."""
    if pd.isna(source) or str(source).strip() == '':
        return 'dealer'
    return 'digital' if str(source).strip().lower() in DIGITAL_PLATFORMS else 'dealer'


def _dealer_from_source(source: str) -> str:
    """
    Return the dealer name from the Source Channel field.
    Named people (MT, Nate, Grant, Thakier, etc.) → their name.
    Digital platforms (Goldstore, web, app, etc.) → '' (no dealer).
    """
    if pd.isna(source) or str(source).strip() == '':
        return ''
    s = str(source).strip()
    return '' if s.lower() in DIGITAL_PLATFORMS else s


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
    The dealing sheet has two sets of deals side by side (left = buys, right = sells).
    Pandas appends '.1' to duplicate column names. If column names differ between
    the two halves, fall back to a midpoint column split.
    """
    if suffix:
        # Primary: look for columns ending with the suffix (.1 = right/sell side)
        cols = {c: c[:-len(suffix)] for c in df.columns if c.endswith(suffix)}
        if cols:
            return df[list(cols.keys())].rename(columns=cols)
        # Fallback: no .1 columns — take right half of the dataframe by column index
        mid = len(df.columns) // 2
        right = df.iloc[:, mid:].copy()
        # Rename right-half columns to match the left-half names
        right.columns = [str(c).split('.')[0].strip() for c in right.columns]
        return right
    else:
        # Left half: columns that do NOT end with '.1'
        left_cols = [c for c in df.columns if not c.endswith('.1')]
        if left_cols:
            return df[left_cols].copy()
        # Fallback: take left half by column index
        mid = len(df.columns) // 2
        return df.iloc[:, :mid].copy()


def _parse_deal_tab(df: pd.DataFrame, metal: str, entity: str,
                    source_file: str,
                    row_statuses: dict = None) -> list:
    """
    Parse all deals from a single sheet tab (one half at a time).
    Left half (no suffix) = BUYBACKS (buys).
    Right half (.1 suffix) = SALES (sells).

    row_statuses: {excel_row_number: 'confirmed'|'quote'|'proof'|''}
      - pandas row index 0 → excel row 2 (header is row 1)
      - confirmed / proof → import as deal
      - quote → import as pipeline entry only
      - '' (no colour) → skip (header / blank row)

    Returns list of normalised deal dicts ready for _process_row.
    Each dict includes 'status' and 'product_type' fields.
    """
    deals = []
    has_colours = bool(row_statuses) and any(s for s in row_statuses.values())

    side_deal_type = {'': 'buy', '.1': 'sell'}

    for suffix in ['', '.1']:
        half = _extract_half(df, suffix)
        half = _map_sabis_cols(half)
        deal_type = side_deal_type[suffix]

        if 'spot_price_zar' not in half.columns:
            continue

        if 'deal_date' in half.columns:
            half['deal_date'] = half['deal_date'].ffill()

        for pandas_idx, row in half.iterrows():
            # Determine row status from colour
            if has_colours:
                # pandas row 0 → excel row 2 (1-indexed, with header at row 1)
                excel_row = pandas_idx + 2
                status = row_statuses.get(excel_row, '')
                if not status:
                    continue   # no colour → skip (blank / header row)
            else:
                status = 'confirmed'  # no colour data → treat all as confirmed

            try:
                spot  = float(row.get('spot_price_zar', ''))
                units = float(row.get('units', ''))
            except (ValueError, TypeError):
                continue

            # Use Total Ounces directly if available; fall back to Qty × UOM
            try:
                oz_direct = float(row.get('oz', '') or '')
                if oz_direct > 0:
                    equiv = oz_direct / units if units else 1.0
                else:
                    raise ValueError
            except (ValueError, TypeError):
                try:
                    equiv = float(row.get('equiv_oz', 1.0) or 1.0)
                except (ValueError, TypeError):
                    equiv = 1.0   # UOM is text like "oz" — default 1 oz/unit

            if spot == 0 or units == 0:
                continue

            try:
                margin = float(row.get('margin_pct', 0) or 0)
                if -1 < margin < 1 and margin != 0:
                    margin = margin * 100
            except (ValueError, TypeError):
                margin = 0.0

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

            product_type = 'proof' if status == 'proof' else 'bullion'
            db_status    = 'confirmed' if status in ('confirmed', 'proof') else 'quote'

            oz_val = equiv * units

            deals.append({
                'entity':         entity,
                'metal':          metal,
                'deal_type':      deal_type,
                'deal_date':      deal_date,
                # dealer_name = the SA Bullion dealer (from Source Channel)
                # client_name = the client they dealt with
                'dealer_name':    _dealer_from_source(source),
                'client_name':    str(row.get('client_name', '') or ''),
                'silo':           _silo_from_movement(movement),
                'channel':        _channel_from_source(source),
                'product_code':   str(row.get('product_code', '') or ''),
                'product_name':   str(row.get('product_name', '') or ''),
                'units':          units,
                'equiv_oz':       equiv,
                'oz':             oz_val,
                'spot_price_zar': spot,
                'margin_pct':     margin,
                'source_file':    source_file,
                'status':         db_status,
                'product_type':   product_type,
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


def process_file(filepath: str, entity: str = 'SABIS',
                 display_name: str = None) -> dict:
    """
    Main entry point. Reads, validates, and processes a dealer Excel file.
    Auto-detects SABIS dealing sheet format vs generic format.
    Returns summary of what was imported.

    display_name: the original user-facing filename (used when filepath is a
                  UUID temp path created by the upload endpoint).
    """
    import tempfile, warnings
    warnings.filterwarnings('ignore', category=UserWarning)

    filename = display_name or os.path.basename(filepath)
    print(f"\nProcessing: {filename}")

    # Only copy to temp if the file is NOT already in the temp directory.
    # When called from the upload endpoint the file is already a UUID temp
    # copy — copying it again to the same path causes a Windows sharing error.
    src_abs  = os.path.abspath(filepath)
    tmp_dir  = os.path.abspath(tempfile.gettempdir())
    in_temp  = os.path.dirname(src_abs) == tmp_dir

    if in_temp:
        # Already a local temp file — use it directly, no copy needed.
        tmp_path = filepath
    else:
        # File is on OneDrive / network — copy to local temp first.
        tmp_path = os.path.join(tempfile.gettempdir(), os.path.basename(filepath))
        try:
            shutil.copy2(filepath, tmp_path)
        except Exception as e:
            _move_to_errors(filepath, f"Could not read file: {e}")
            return {'status': 'error', 'file': filename, 'error': str(e)}

    try:
        sheet_names = _get_sheet_names(tmp_path)
    except Exception as e:
        if not in_temp:
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
    all_errors      = []
    processed_deals = []
    pipeline_deals  = []

    print(f"  Deal tabs detected: {deal_tabs}")

    for tab in deal_tabs:
        metal = _metal_from_tab(tab)
        print(f"  Tab: '{tab}' -> metal={metal}")

        # Read row colours with openpyxl (uses full mode, not read_only)
        row_statuses = _read_row_statuses(src, tab)
        colour_counts = {}
        for s in row_statuses.values():
            colour_counts[s or 'none'] = colour_counts.get(s or 'none', 0) + 1
        print(f"    Row colours: {colour_counts}")

        try:
            df = pd.read_excel(src, sheet_name=tab, dtype=str, header=0,
                               engine='openpyxl')
            df = df.copy()   # detach from the file handle immediately
        except Exception as e:
            all_errors.append(f"Tab '{tab}': could not read — {e}")
            continue

        deals = _parse_deal_tab(df, metal, entity, filename, row_statuses)
        confirmed = [d for d in deals if d['status'] == 'confirmed']
        quotes    = [d for d in deals if d['status'] == 'quote']
        print(f"    Confirmed: {len(confirmed)}  |  Quotes: {len(quotes)}")

        # Insert confirmed (including proof) deals into deals table
        for deal in confirmed:
            try:
                result = _process_row(deal, filename)
                if result:
                    processed_deals.append(result)
            except Exception as e:
                all_errors.append(f"Tab '{tab}': row error — {e}")

        # Insert quotes into pipeline table
        for deal in quotes:
            try:
                _insert_pipeline_row(deal)
                pipeline_deals.append(deal)
            except Exception as e:
                all_errors.append(f"Tab '{tab}': pipeline row error — {e}")

    if not processed_deals and not pipeline_deals:
        _move_to_errors(filepath, '\n'.join(all_errors) if all_errors
                        else 'No coloured deal rows found. Check orange/yellow/blue row highlighting.')
        return {'status': 'error', 'file': filename, 'errors': all_errors}

    # Per-metal breakdown
    metal_breakdown = {}
    for d in processed_deals:
        m = d.get('metal', 'unknown')
        metal_breakdown[m] = metal_breakdown.get(m, 0) + 1

    _move_to_processed(filepath)
    print(f"Imported {len(processed_deals)} confirmed deals "
          f"({metal_breakdown}), "
          f"{len(pipeline_deals)} pipeline quotes. Warnings: {len(all_errors)}")
    return {
        'status':            'success' if not all_errors else 'partial',
        'file':              filename,
        'deals_imported':    len(processed_deals),
        'pipeline_imported': len(pipeline_deals),
        'metal_breakdown':   metal_breakdown,
        'warnings':          all_errors,
        'deals':             processed_deals,
    }


def _insert_pipeline_row(deal: dict):
    """Save a quote/pipeline deal to the pipeline table."""
    record = {
        'entity':         deal['entity'],
        'metal':          deal['metal'],
        'deal_type':      deal['deal_type'],
        'deal_date':      deal.get('deal_date', ''),
        'client_name':    deal.get('client_name', ''),
        'product_name':   deal.get('product_name', ''),
        'product_code':   deal.get('product_code', ''),
        'units':          deal.get('units', 0),
        'oz':             deal.get('units', 0) * deal.get('equiv_oz', 1.0),
        'spot_price_zar': deal.get('spot_price_zar', 0),
        'margin_pct':     deal.get('margin_pct', 0),
        'deal_value_zar': deal.get('spot_price_zar', 0) * deal.get('units', 0) * deal.get('equiv_oz', 1.0),
        'product_type':   deal.get('product_type', 'bullion'),
        'source_file':    deal.get('source_file', ''),
    }
    insert_pipeline(record)


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
    oz        = float(row.get('oz', 0) or 0) or (equiv_oz * units)

    deal_date = str(row.get('deal_date', date.today().isoformat()))[:10]

    current_inventory = get_inventory(entity, metal)
    provision         = get_provision_mode(current_inventory, metal)
    provision_pct     = provision['rate_pct']

    # Sells: client pays above spot  → effective = spot × (1 + margin%)
    # Buys:  company pays below spot → effective = spot × (1 − margin%)
    if deal_type == 'sell':
        effective_price = spot * (1 + margin_pct / 100)
    else:
        effective_price = spot * (1 - margin_pct / 100)

    deal_value = effective_price * oz

    # GP = profit vs provision hurdle × deal notional (spot × oz)
    # Using spot × oz as the base keeps GP independent of the margin direction
    notional    = spot * oz
    mvp = margin_vs_provision(margin_pct, provision_pct, deal_type)
    gp  = calc_gp_contribution(mvp['profit_pct'], notional)

    inv_delta     = oz if deal_type == 'buy' else -oz
    new_inventory = current_inventory + inv_delta
    flipped       = (current_inventory >= 0 and new_inventory < 0) or \
                    (current_inventory < 0  and new_inventory >= 0)

    deal_record = {
        'entity':              entity,
        'metal':               metal,
        'deal_type':           deal_type,
        'deal_date':           deal_date,
        'dealer_name':         str(row.get('dealer_name', '')),
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
        'status':              str(row.get('status', 'confirmed')),
        'product_type':        str(row.get('product_type', 'bullion')),
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
