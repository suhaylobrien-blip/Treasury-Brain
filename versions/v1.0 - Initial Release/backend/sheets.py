"""
Treasury Brain — Google Sheets Writer
Reads/writes to the designated reporting Google Sheets per entity+metal.
"""

import json
import os

CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'settings.json')
CREDS_PATH  = os.path.join(os.path.dirname(__file__), '..', 'config', 'credentials.json')

with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

SHEET_IDS = CONFIG.get('google_sheets', {})


def _get_client():
    """Returns authenticated gspread client."""
    import gspread
    from google.oauth2.service_account import Credentials

    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
    ]
    creds  = Credentials.from_service_account_file(CREDS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def _get_sheet(entity: str, metal: str):
    """Returns the gspread Spreadsheet object for a given entity+metal combo."""
    key = f"{entity}_{metal}"
    sheet_id = SHEET_IDS.get(key)
    if not sheet_id:
        raise ValueError(f"No Google Sheet ID configured for {key}. "
                         f"Add it to config/settings.json → google_sheets.")
    gc = _get_client()
    return gc.open_by_key(sheet_id)


def write_daily_summary(entity: str, metal: str, summary: dict):
    """
    Writes today's daily summary into the reporting Google Sheet.
    Assumes a standard layout — adapt cell references as needed for your sheets.
    """
    try:
        wb = _get_sheet(entity, metal)
        ws = wb.worksheet('Daily Summary')

        today = summary['date']
        # Find or create a row for today (column A = date)
        date_col = ws.col_values(1)
        if today in date_col:
            row = date_col.index(today) + 1
        else:
            row = len(date_col) + 1
            ws.update_cell(row, 1, today)

        # Write values — adapt column indices to your sheet layout
        updates = [
            (row, 2,  summary['deal_count']),
            (row, 3,  summary['buy_oz']),
            (row, 4,  summary['sell_oz']),
            (row, 5,  summary['buy_value_zar']),
            (row, 6,  summary['sell_value_zar']),
            (row, 7,  summary['buy_vwap']),
            (row, 8,  summary['sell_vwap']),
            (row, 9,  summary['buy_margin_vwap']),
            (row, 10, summary['sell_margin_vwap']),
            (row, 11, summary['total_gp_zar']),
            (row, 12, summary['inventory_oz']),
            (row, 13, summary['spot_price_zar']),
            (row, 14, summary['inventory_value_zar']),
            (row, 15, summary['provision_mode']['mode']),
            (row, 16, summary['provision_mode']['rate_pct']),
        ]
        for r, c, val in updates:
            ws.update_cell(r, c, val)

        print(f"[sheets] Updated Daily Summary: {entity} {metal} ({today})")

    except Exception as e:
        print(f"[sheets] Write failed for {entity} {metal}: {e}")


def write_deals(entity: str, metal: str, deals: list):
    """
    Appends deal rows to the 'Deals' tab of the reporting Google Sheet.
    """
    if not deals:
        return
    try:
        wb = _get_sheet(entity, metal)
        ws = wb.worksheet('Deals')

        headers = [
            'deal_id', 'deal_date', 'deal_type', 'dealer_name', 'silo', 'channel',
            'product_code', 'product_name', 'units', 'equiv_oz_per_unit', 'oz',
            'spot_price_zar', 'margin_pct', 'effective_price_zar', 'deal_value_zar',
            'provision_pct', 'profit_margin_pct', 'gp_contribution_zar',
            'inventory_after_oz', 'provision_flipped',
        ]

        rows = []
        for d in deals:
            rows.append([d.get(h, '') for h in headers])

        ws.append_rows(rows, value_input_option='USER_ENTERED')
        print(f"[sheets] Appended {len(deals)} deals: {entity} {metal}")

    except Exception as e:
        print(f"[sheets] Deal write failed for {entity} {metal}: {e}")


def read_sheet_range(entity: str, metal: str, worksheet_name: str,
                     cell_range: str) -> list:
    """
    Reads a range from a Google Sheet tab. Returns list of rows.
    e.g. read_sheet_range('SABIS', 'gold', 'Inventory', 'A1:E20')
    """
    wb = _get_sheet(entity, metal)
    ws = wb.worksheet(worksheet_name)
    return ws.get(cell_range)
