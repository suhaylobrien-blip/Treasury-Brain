"""
Treasury Brain — Flask Web Server
API endpoints + serves the web dashboard.
"""

import json
import os
import tempfile
from datetime import date, datetime
from flask import Flask, jsonify, request, send_from_directory, abort

from models import (
    get_deals, get_inventory, get_aged_inventory, get_latest_spot,
    get_cash_flows, insert_spot_price, init_db, reset_entity_data,
    set_inventory_position,
    get_hedging_positions, insert_hedging_position, close_hedging_position,
    get_pipeline, delete_pipeline_row
)
from processor import (
    get_provision_mode, live_impact_preview, build_daily_summary,
    calc_silo_analytics, calc_channel_analytics, flag_dormant, optimal_exit_suggestion
)
from importer import process_file
from spot_prices import fetch_all_spots

CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'settings.json')
with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend')
INBOX_DIR    = os.path.join(os.path.dirname(__file__), '..', CONFIG['inbox_folder'])

app = Flask(__name__, static_folder=FRONTEND_DIR)


# ─────────────────────────────────────────────
# SERVE FRONTEND
# ─────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(FRONTEND_DIR, 'index.html')


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)


# ─────────────────────────────────────────────
# DASHBOARD DATA
# ─────────────────────────────────────────────

@app.route('/api/dashboard')
def dashboard():
    """Full dashboard snapshot: all entities, all metals."""
    entities = CONFIG['entities']
    metals   = CONFIG['metals']
    today    = date.today().isoformat()
    result   = {}

    for entity in entities:
        result[entity] = {}
        for metal in metals:
            inventory_oz = get_inventory(entity, metal)
            spot         = get_latest_spot(metal)
            provision    = get_provision_mode(inventory_oz, metal)
            deals_today  = get_deals(entity, metal, today)

            summary = build_daily_summary(entity, metal, deals_today, inventory_oz, spot)

            result[entity][metal] = {
                'inventory_oz':       round(inventory_oz, 6),
                'inventory_value_zar': round(inventory_oz * spot, 2),
                'spot_price_zar':     spot,
                'provision_mode':     provision,
                'deal_count_today':   len(deals_today),
                'total_gp_today':     summary['total_gp_zar'],
                'buy_vwap':           summary['buy_vwap'],
                'sell_vwap':          summary['sell_vwap'],
                'buy_margin_vwap':    summary['buy_margin_vwap'],
                'sell_margin_vwap':   summary['sell_margin_vwap'],
                'silo_analytics':     summary['silo_analytics'],
                'channel_analytics':  summary['channel_analytics'],
            }

    return jsonify(result)


@app.route('/api/deals')
def deals_endpoint():
    """Return deals, filtered by entity, metal, and optional date / date range."""
    entity    = request.args.get('entity', 'SABIS')
    metal     = request.args.get('metal',  'gold')
    deal_date = request.args.get('date')
    from_date = request.args.get('from')
    to_date   = request.args.get('to')
    limit     = request.args.get('limit', type=int)
    deals     = get_deals(entity, metal, deal_date,
                          from_date=from_date, to_date=to_date, limit=limit)
    return jsonify(deals)


@app.route('/api/inventory')
def inventory_endpoint():
    """Return current inventory for a given entity + metal."""
    entity   = request.args.get('entity', 'SABIS')
    metal    = request.args.get('metal', 'gold')
    oz       = get_inventory(entity, metal)
    spot     = get_latest_spot(metal)
    aged     = get_aged_inventory(entity, metal)

    dormant_parcels = []
    for parcel in aged:
        acq = datetime.strptime(parcel['acquired_date'], '%Y-%m-%d').date()
        dom = flag_dormant(acq)
        parcel['dormancy'] = dom
        if dom['flagged']:
            parcel['exit_suggestion'] = optimal_exit_suggestion(
                {**parcel, 'metal': metal}, spot,
                get_provision_mode(oz, metal)['rate_pct']
            )
        dormant_parcels.append(parcel)

    return jsonify({
        'entity':      entity,
        'metal':       metal,
        'total_oz':    round(oz, 6),
        'spot_zar':    spot,
        'value_zar':   round(oz * spot, 2),
        'provision':   get_provision_mode(oz, metal),
        'aged_parcels': dormant_parcels,
    })


@app.route('/api/inventory/set', methods=['POST'])
def set_inventory():
    """
    Directly set the opening inventory position for an entity + metal.
    Use this to enter the true ecosystem position before importing deals.
    Negative oz = short = provision mode active.
    Body: { entity, metal, oz }
    """
    data   = request.json or {}
    entity = data.get('entity', 'SABIS').upper()
    metal  = data.get('metal',  'gold').lower()
    oz     = float(data.get('oz', 0))
    set_inventory_position(entity, metal, oz)
    provision = get_provision_mode(oz, metal)
    return jsonify({
        'status':    'ok',
        'entity':    entity,
        'metal':     metal,
        'total_oz':  oz,
        'provision': provision,
    })


@app.route('/api/cash-flows')
def cash_flows_endpoint():
    """Return cash flows for an entity, with optional date range."""
    entity    = request.args.get('entity', 'SABIS')
    from_date = request.args.get('from')
    to_date   = request.args.get('to')
    flows     = get_cash_flows(entity, from_date, to_date)
    return jsonify(flows)


@app.route('/api/spot')
def spot_endpoint():
    """Return latest spot prices for all metals."""
    return jsonify({
        metal: get_latest_spot(metal)
        for metal in CONFIG['metals']
    })


@app.route('/api/spot/refresh', methods=['POST'])
def refresh_spot():
    """Fetch fresh spot prices from API."""
    prices = fetch_all_spots()
    return jsonify(prices)


@app.route('/api/spot/manual', methods=['POST'])
def manual_spot():
    """Manually set a spot price. Body: {metal, price_zar}"""
    data = request.json
    metal     = data.get('metal')
    price_zar = data.get('price_zar')
    if not metal or not price_zar:
        return jsonify({'error': 'metal and price_zar required'}), 400
    insert_spot_price(metal, float(price_zar), source='manual')
    return jsonify({'status': 'ok', 'metal': metal, 'price_zar': price_zar})


# ─────────────────────────────────────────────
# LIVE IMPACT PREVIEW (what-if)
# ─────────────────────────────────────────────

@app.route('/api/preview', methods=['POST'])
def preview():
    """
    What-if deal preview — shows full impact before confirming.
    Body: { entity, metal, deal_type, units, equiv_oz, spot_price_zar, margin_pct }
    """
    data = request.json
    entity    = data.get('entity', 'SABIS')
    metal     = data.get('metal', 'gold')
    deal_type = data.get('deal_type', 'sell')
    units     = float(data.get('units', 1))
    equiv_oz  = float(data.get('equiv_oz', 1.0))
    spot_raw  = data.get('spot_price_zar')
    spot      = float(spot_raw) if spot_raw is not None else float(get_latest_spot(metal) or 0)
    margin    = float(data.get('margin_pct', 0))

    oz           = units * equiv_oz
    inventory_oz = get_inventory(entity, metal)
    provision    = get_provision_mode(inventory_oz, metal)

    # Build running totals from today's deals for VWAP
    today       = date.today().isoformat()
    deals_today = get_deals(entity, metal, today)
    total_val   = sum(d['deal_value_zar'] for d in deals_today)
    total_oz    = sum(d['oz'] for d in deals_today)

    deal = {
        'type':       deal_type,
        'oz':         oz,
        'spot_price': spot,
        'margin_pct': margin,
        'metal':      metal,
    }
    current_state = {
        'total_value_zar': total_val,
        'total_oz':        total_oz,
        'inventory_oz':    inventory_oz,
        'cash_zar':        0.0,  # cash position not tracked per-session; use cash_flows
    }

    impact = live_impact_preview(deal, current_state, provision['rate_pct'])
    impact['entity']   = entity
    impact['metal']    = metal
    impact['units']    = units
    impact['equiv_oz'] = equiv_oz
    return jsonify(impact)


# ─────────────────────────────────────────────
# SUMMARY / ANALYTICS
# ─────────────────────────────────────────────

@app.route('/api/summary')
def summary_endpoint():
    """Build and return the daily summary for one entity+metal."""
    entity   = request.args.get('entity', 'SABIS')
    metal    = request.args.get('metal', 'gold')
    on_date  = request.args.get('date', date.today().isoformat())

    deals        = get_deals(entity, metal, on_date)
    inventory_oz = get_inventory(entity, metal)
    spot         = get_latest_spot(metal)
    summary      = build_daily_summary(entity, metal, deals, inventory_oz, spot)
    return jsonify(summary)


@app.route('/api/analytics/silo')
def silo_analytics():
    entity  = request.args.get('entity', 'SABIS')
    metal   = request.args.get('metal', 'gold')
    on_date = request.args.get('date')
    deals   = get_deals(entity, metal, on_date)
    return jsonify(calc_silo_analytics(deals))


@app.route('/api/analytics/channel')
def channel_analytics():
    entity  = request.args.get('entity', 'SABIS')
    metal   = request.args.get('metal', 'gold')
    on_date = request.args.get('date')
    deals   = get_deals(entity, metal, on_date)
    return jsonify(calc_channel_analytics(deals))


# ─────────────────────────────────────────────
# HEDGING POSITIONS
# ─────────────────────────────────────────────

@app.route('/api/hedging')
def hedging_endpoint():
    """Return all open hedge/position entries for an entity + metal."""
    entity = request.args.get('entity', 'SABIS')
    metal  = request.args.get('metal',  'gold')
    positions = get_hedging_positions(entity, metal)
    long_oz  = sum(p['contract_oz'] for p in positions if p['position_type'] == 'long')
    short_oz = sum(p['contract_oz'] for p in positions if p['position_type'] == 'short')
    return jsonify({
        'positions': positions,
        'long_oz':   round(long_oz,  2),
        'short_oz':  round(short_oz, 2),
        'net_oz':    round(long_oz - short_oz, 2),
    })


@app.route('/api/hedging', methods=['POST'])
def add_hedging():
    """
    Add a hedging / position entry.
    Body: { entity, metal, position_type ('long'|'short'), contract_oz,
            open_price_zar, platform, notes, open_date (optional) }
    """
    data   = request.json or {}
    entity = data.get('entity', 'SABIS').upper()
    metal  = data.get('metal',  'gold').lower()
    record = {
        'entity':         entity,
        'metal':          metal,
        'position_type':  data.get('position_type', 'long'),
        'open_date':      data.get('open_date', date.today().isoformat()),
        'contract_oz':    float(data.get('contract_oz', 0)),
        'open_price_zar': float(data.get('open_price_zar') or get_latest_spot(metal)),
        'platform':       data.get('platform', ''),
        'notes':          data.get('notes', ''),
        'status':         'open',
    }
    position_id = insert_hedging_position(record)
    return jsonify({'status': 'ok', 'id': position_id})


@app.route('/api/hedging/<int:position_id>', methods=['DELETE'])
def remove_hedging(position_id):
    """Close/remove a hedging position by id."""
    close_hedging_position(position_id)
    return jsonify({'status': 'ok', 'closed': position_id})


# ─────────────────────────────────────────────
# FILE UPLOAD (manual trigger)
# ─────────────────────────────────────────────

@app.route('/api/reset', methods=['POST'])
def reset_data():
    """
    Wipe all deals + inventory for a given entity + metal so they can be
    re-imported with corrected GP/provision calculations.
    Body: { entity, metal }  — defaults to SABIS + gold if omitted.
    """
    data   = request.json or {}
    entity = data.get('entity', 'SABIS').upper()
    metal  = data.get('metal',  'gold').lower()
    reset_entity_data(entity, metal)
    return jsonify({'status': 'ok', 'cleared': f'{entity} / {metal}'})


@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Upload a dealer Excel file for immediate processing."""
    import uuid
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    f = request.files['file']
    if f.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # Use a unique temp filename (UUID prefix) so a previously locked copy of
    # the same filename never blocks this upload on Windows.
    original_name = f.filename
    ext           = os.path.splitext(original_name)[1]
    tmp_name      = f"{uuid.uuid4().hex}{ext}"
    save_path     = os.path.join(tempfile.gettempdir(), tmp_name)
    f.save(save_path)

    try:
        result = process_file(save_path, display_name=original_name)
    finally:
        # Clean up the unique temp file whether processing succeeded or not
        try:
            os.remove(save_path)
        except OSError:
            pass

    return jsonify(result)


@app.route('/api/pipeline')
def pipeline_endpoint():
    """Return pipeline (yellow/quote) deals for an entity + metal."""
    entity    = request.args.get('entity', 'SABIS')
    metal     = request.args.get('metal',  'gold')
    from_date = request.args.get('from')
    to_date   = request.args.get('to')
    rows      = get_pipeline(entity, metal, from_date, to_date)
    return jsonify(rows)


@app.route('/api/pipeline/<int:pipeline_id>/confirm', methods=['POST'])
def confirm_pipeline(pipeline_id):
    """Promote a yellow/quote pipeline deal to a confirmed deal."""
    from importer import _process_row
    from models import get_conn
    conn = get_conn()
    row  = conn.execute("SELECT * FROM pipeline WHERE id=?", (pipeline_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Pipeline deal not found'}), 404
    deal = dict(row)
    # Fill required fields for _process_row
    deal.setdefault('silo',         'retail')
    deal.setdefault('channel',      'dealer')
    deal.setdefault('dealer_name',  '')
    deal.setdefault('status',       'confirmed')
    deal.setdefault('product_type', 'bullion')
    deal.setdefault('equiv_oz',     1.0)
    try:
        result = _process_row(deal, deal.get('source_file', 'manual-confirm'))
        delete_pipeline_row(pipeline_id)
        return jsonify({'status': 'ok', 'deal_id': result.get('deal_id')})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    os.makedirs(INBOX_DIR, exist_ok=True)
    print("Treasury Brain server starting on http://localhost:5000")
    app.run(debug=True, host='0.0.0.0', port=5000)
