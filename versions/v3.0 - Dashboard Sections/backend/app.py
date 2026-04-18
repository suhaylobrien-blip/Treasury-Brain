"""
Treasury Brain — Flask Web Server
API endpoints + serves the web dashboard.
"""

import json
import os
import tempfile
from datetime import date, datetime
from flask import Flask, jsonify, request, send_from_directory, abort

import models
from models import (
    get_deals, get_inventory, get_aged_inventory, get_latest_spot, get_spot_age_seconds,
    get_cash_flows, insert_spot_price, init_db, reset_entity_data,
    set_inventory_position,
    get_hedging_positions, insert_hedging_position, close_hedging_position,
    get_realized_hedge_pnl,
    get_pipeline, delete_pipeline_row,
    get_funding_costs, insert_funding_cost, delete_funding_cost
)
from processor import (
    get_provision_mode, live_impact_preview, build_daily_summary,
    calc_silo_analytics, calc_channel_analytics, flag_dormant, optimal_exit_suggestion
)
from importer import process_file
from spot_prices import fetch_all_spots, get_zar_rate

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
            provision    = get_provision_mode(inventory_oz, metal, entity)
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
    """Return current live inventory for a given entity + metal.
    Live oz = base position (manually reconciled) + all buys - all sells.
    Hedge net is kept separate (returned by /api/hedging) and added by the
    frontend to produce ecosystem net exposure.
    """
    entity   = request.args.get('entity', 'SABIS')
    metal    = request.args.get('metal', 'gold')

    base_oz  = get_inventory(entity, metal)      # reconciled starting position
    spot     = get_latest_spot(metal)
    aged     = get_aged_inventory(entity, metal)

    # Live physical position: base + all deal buys − all deal sells
    all_deals = get_deals(entity, metal)
    buy_oz    = sum(d['oz'] for d in all_deals if d['deal_type'] == 'buy')
    sell_oz   = sum(d['oz'] for d in all_deals if d['deal_type'] == 'sell')
    deal_net  = buy_oz - sell_oz
    live_oz   = base_oz + deal_net

    prov_rate = get_provision_mode(live_oz, metal, entity)['rate_pct']
    dormant_parcels = []
    for parcel in aged:
        acq = datetime.strptime(parcel['acquired_date'], '%Y-%m-%d').date()
        dom = flag_dormant(acq)
        parcel['dormancy'] = dom
        if dom['flagged']:
            parcel['exit_suggestion'] = optimal_exit_suggestion(
                {**parcel, 'metal': metal}, spot, prov_rate
            )
        dormant_parcels.append(parcel)

    return jsonify({
        'entity':     entity,
        'metal':      metal,
        'total_oz':   round(live_oz,  6),   # live: base + buys − sells
        'base_oz':    round(base_oz,  6),   # reconciled base position
        'buy_oz':     round(buy_oz,   4),
        'sell_oz':    round(sell_oz,  4),
        'deal_net':   round(deal_net, 4),
        'spot_zar':   spot,
        'value_zar':  round(live_oz * spot, 2),
        'provision':  get_provision_mode(live_oz, metal, entity),
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
    provision = get_provision_mode(oz, metal, entity)
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


SPOT_STALE_SECONDS = 300  # re-fetch from GoldStore if price is older than 5 minutes

@app.route('/api/spot')
def spot_endpoint():
    """Return latest spot prices. Auto-fetches from GoldStore if missing or stale (>5 min)."""
    needs_fetch = any(
        get_spot_age_seconds(metal) > SPOT_STALE_SECONDS
        for metal in CONFIG['metals']
    )
    if needs_fetch:
        result = fetch_all_spots()
    else:
        result = {metal: get_latest_spot(metal) for metal in CONFIG['metals']}

    result['usd_rate'] = get_zar_rate()
    return jsonify(result)


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
    provision    = get_provision_mode(inventory_oz, metal, entity)

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
    """Return all open hedge/position entries for an entity + metal, with VWAP."""
    entity    = request.args.get('entity', 'SABIS')
    metal     = request.args.get('metal',  'gold')
    from_date = request.args.get('from')
    to_date   = request.args.get('to')
    positions = get_hedging_positions(entity, metal, from_date, to_date)

    longs  = [p for p in positions if p['position_type'] == 'long']
    shorts = [p for p in positions if p['position_type'] == 'short']

    long_oz  = sum(p['contract_oz'] for p in longs)
    short_oz = sum(p['contract_oz'] for p in shorts)

    # VWAP = Σ(price × oz) / Σ(oz)
    long_val   = sum(p['open_price_zar'] * p['contract_oz'] for p in longs)
    short_val  = sum(p['open_price_zar'] * p['contract_oz'] for p in shorts)
    long_vwap  = long_val  / long_oz  if long_oz  > 0 else 0
    short_vwap = short_val / short_oz if short_oz > 0 else 0

    return jsonify({
        'positions':  positions,
        'long_oz':    round(long_oz,    2),
        'short_oz':   round(short_oz,   2),
        'net_oz':     round(long_oz - short_oz, 2),
        'long_vwap':  round(long_vwap,  2),
        'short_vwap': round(short_vwap, 2),
        'long_val':   round(long_val,   2),
        'short_val':  round(short_val,  2),
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
    """Close a hedging position. Accepts optional {close_price_zar} in JSON body."""
    data        = request.get_json(silent=True) or {}
    close_price = data.get('close_price_zar')
    pnl         = close_hedging_position(position_id, close_price)
    return jsonify({'status': 'ok', 'closed': position_id, 'pnl_zar': round(pnl, 2)})


@app.route('/api/hedging/realized')
def hedging_realized():
    """Realized PNL from formally closed hedge positions."""
    entity    = request.args.get('entity', 'SABIS')
    metal     = request.args.get('metal',  'gold')
    from_date = request.args.get('from')
    to_date   = request.args.get('to')
    return jsonify(get_realized_hedge_pnl(entity, metal, from_date, to_date))


# ─────────────────────────────────────────────
# FUNDING COSTS (swap fees / interest)
# ─────────────────────────────────────────────

@app.route('/api/funding-costs')
def funding_costs_get():
    entity    = request.args.get('entity', 'SABIS')
    metal     = request.args.get('metal')          # optional — omit for all metals
    from_date = request.args.get('from')
    to_date   = request.args.get('to')
    rows      = get_funding_costs(entity, metal, from_date, to_date)

    gold_swap   = sum(r['amount_zar'] for r in rows if r['metal'] == 'gold'   and r['cost_type'] == 'swap_fee')
    silver_swap = sum(r['amount_zar'] for r in rows if r['metal'] == 'silver' and r['cost_type'] == 'swap_fee')
    gold_int    = sum(r['amount_zar'] for r in rows if r['metal'] == 'gold'   and r['cost_type'] == 'interest_earned')
    silver_int  = sum(r['amount_zar'] for r in rows if r['metal'] == 'silver' and r['cost_type'] == 'interest_earned')

    return jsonify({
        'rows':         rows,
        'summary': {
            'gold_swap_fees':       round(gold_swap,   2),
            'silver_swap_fees':     round(silver_swap, 2),
            'gold_interest':        round(gold_int,    2),
            'silver_interest':      round(silver_int,  2),
            'total_swap_fees':      round(gold_swap + silver_swap, 2),
            'total_interest':       round(gold_int  + silver_int,  2),
            'net_funding_cost':     round((gold_swap + silver_swap) - (gold_int + silver_int), 2),
        }
    })


@app.route('/api/funding-costs', methods=['POST'])
def funding_costs_post():
    data = request.get_json(force=True)
    required = ('entity', 'metal', 'cost_type', 'amount_zar', 'charge_date')
    if not all(k in data for k in required):
        return jsonify({'error': 'Missing required fields'}), 400
    if data['cost_type'] not in ('swap_fee', 'interest_earned'):
        return jsonify({'error': 'cost_type must be swap_fee or interest_earned'}), 400
    if data['metal'] not in ('gold', 'silver'):
        return jsonify({'error': 'metal must be gold or silver'}), 400

    new_id = insert_funding_cost(
        entity      = data['entity'],
        metal       = data['metal'],
        platform    = data.get('platform', 'Stone X'),
        cost_type   = data['cost_type'],
        amount_zar  = float(data['amount_zar']),
        charge_date = data['charge_date'],
        notes       = data.get('notes', ''),
    )
    return jsonify({'id': new_id, 'status': 'created'}), 201


@app.route('/api/funding-costs/<int:cost_id>', methods=['DELETE'])
def funding_costs_delete(cost_id):
    deleted = delete_funding_cost(cost_id)
    return jsonify({'status': 'deleted' if deleted else 'not_found'})


@app.route('/api/exposure')
def exposure_endpoint():
    """
    FIFO daily book engine with carry-in tracking.

    All history before the selected period is run through FIFO first — the
    resulting open book is the 'carry_in' displayed in the Provision block.
    The period FIFO then starts from that carry-in state.

    Treasury Alpha = Σ (sell_price - buy_price) × oz  across period-matched pairs
    carry_in       = open book entering the period (net oz, VWAP, ZAR value)
    """
    from collections import defaultdict

    entity    = request.args.get('entity', 'SABIS')
    metal     = request.args.get('metal',  'gold')
    from_date = request.args.get('from')
    to_date   = request.args.get('to')

    all_deals = get_deals(entity, metal)               # full history, no date filter
    positions = get_hedging_positions(entity, metal)
    spot      = get_latest_spot(metal)

    # ── FIFO helpers ──────────────────────────────────────────────────────────
    def _events_from(deals_subset, pos_subset):
        evts = []
        for d in deals_subset:
            oz = d['oz'] or 0
            if oz <= 0: continue
            evts.append({
                'date':  d['deal_date'],
                'oz':    oz,
                'price': d['deal_value_zar'] / oz,
                'side':  'long' if d['deal_type'] == 'buy' else 'short',
            })
        for p in pos_subset:
            oz = p['contract_oz'] or 0
            if oz <= 0: continue
            evts.append({
                'date':  p['open_date'],
                'oz':    oz,
                'price': p['open_price_zar'] or 0,
                'side':  'long' if p['position_type'] == 'long' else 'short',
            })
        return evts

    def _run_fifo(events, init_long=None, init_short=None):
        """Return (carry_long, carry_short, matched_pairs), starting from init state."""
        daily = defaultdict(lambda: {'long': [], 'short': []})
        for e in events:
            daily[e['date']][e['side']].append({'oz': e['oz'], 'price': e['price']})
        cl = [dict(x) for x in (init_long  or [])]
        cs = [dict(x) for x in (init_short or [])]
        matched = []
        def _match():
            while cl and cs:
                l, s = cl[0], cs[0]
                oz   = min(l['oz'], s['oz'])
                matched.append({'oz': oz, 'buy_price': l['price'], 'sell_price': s['price']})
                l['oz'] -= oz;  s['oz'] -= oz
                if l['oz'] < 1e-9: cl.pop(0)
                if s['oz'] < 1e-9: cs.pop(0)
        for date in sorted(daily.keys()):
            cl.extend(daily[date]['long'])
            cs.extend(daily[date]['short'])
            _match()
        return cl, cs, matched

    def _book_summary(cl, cs):
        lo  = sum(e['oz'] for e in cl);  so  = sum(e['oz'] for e in cs)
        lv  = sum(e['oz'] * e['price'] for e in cl)
        sv  = sum(e['oz'] * e['price'] for e in cs)
        lvw = lv / lo if lo > 0 else 0
        svw = sv / so if so > 0 else 0
        net = lo - so
        nvw = lvw if net > 0 else (svw if net < 0 else 0)
        return {
            'net_oz':    round(net,          4),
            'net_vwap':  round(nvw,          2),
            'net_zar':   round(abs(net)*nvw, 2),
            'long_oz':   round(lo,           4),
            'short_oz':  round(so,           4),
            'long_vwap': round(lvw,          2),
            'short_vwap':round(svw,          2),
        }

    # ── Split events into pre-period and period ───────────────────────────────
    if from_date:
        pre_deals  = [d for d in all_deals if d['deal_date'] <  from_date]
        per_deals  = [d for d in all_deals if d['deal_date'] >= from_date
                      and (not to_date or d['deal_date'] <= to_date)]
        pre_pos    = [p for p in positions if p['open_date'] <  from_date]
        per_pos    = [p for p in positions if p['open_date'] >= from_date
                      and (not to_date or p['open_date'] <= to_date)]
    else:
        pre_deals  = []
        per_deals  = all_deals if not to_date else [d for d in all_deals if d['deal_date'] <= to_date]
        pre_pos    = []
        per_pos    = positions if not to_date else [p for p in positions if p['open_date'] <= to_date]

    # ── Carry-in: FIFO state at end of pre-period ─────────────────────────────
    empty_carry = {'net_oz': 0, 'net_vwap': 0, 'net_zar': 0,
                   'long_oz': 0, 'short_oz': 0, 'long_vwap': 0, 'short_vwap': 0}
    init_long, init_short = [], []
    if pre_deals or pre_pos:
        init_long, init_short, _ = _run_fifo(_events_from(pre_deals, pre_pos))
    carry_in = _book_summary(init_long, init_short) if (init_long or init_short) else empty_carry

    # ── Period FIFO — continues from carry-in state ───────────────────────────
    period_events = _events_from(per_deals, per_pos)
    carry_long, carry_short, matched_pairs = _run_fifo(period_events, init_long, init_short)

    total_matched  = sum(m['oz'] for m in matched_pairs)
    realized_alpha = sum((m['sell_price'] - m['buy_price']) * m['oz'] for m in matched_pairs)

    # ── Open book at end of period ────────────────────────────────────────────
    open_long_oz    = sum(e['oz'] for e in carry_long)
    open_short_oz   = sum(e['oz'] for e in carry_short)
    open_long_val   = sum(e['oz'] * e['price'] for e in carry_long)
    open_short_val  = sum(e['oz'] * e['price'] for e in carry_short)
    open_long_vwap  = open_long_val  / open_long_oz  if open_long_oz  > 0 else 0
    open_short_vwap = open_short_val / open_short_oz if open_short_oz > 0 else 0
    net_oz = open_long_oz - open_short_oz

    if net_oz > 0:
        unrealized_mtm = (spot - open_long_vwap)  * net_oz      if open_long_vwap  > 0 else 0
    elif net_oz < 0:
        unrealized_mtm = (open_short_vwap - spot) * abs(net_oz) if open_short_vwap > 0 else 0
    else:
        unrealized_mtm = 0

    # ── Aggregate display panels (period only) ────────────────────────────────
    buys   = [d for d in per_deals if d['deal_type']     == 'buy']
    sells  = [d for d in per_deals if d['deal_type']     == 'sell']
    longs  = [p for p in per_pos   if p['position_type'] == 'long']
    shorts = [p for p in per_pos   if p['position_type'] == 'short']
    buy_oz   = sum(d['oz']                              for d in buys)
    sell_oz  = sum(d['oz']                              for d in sells)
    long_oz  = sum(p['contract_oz']                     for p in longs)
    short_oz = sum(p['contract_oz']                     for p in shorts)
    buy_val  = sum(d['deal_value_zar']                  for d in buys)
    sell_val = sum(d['deal_value_zar']                  for d in sells)
    long_val = sum(p['open_price_zar'] * p['contract_oz'] for p in longs)
    short_val= sum(p['open_price_zar'] * p['contract_oz'] for p in shorts)
    agg_b_oz = buy_oz + long_oz;  agg_s_oz = sell_oz + short_oz
    agg_b_val= buy_val+ long_val; agg_s_val= sell_val+ short_val
    agg_buy_vwap  = agg_b_val / agg_b_oz if agg_b_oz > 0 else 0
    agg_sell_vwap = agg_s_val / agg_s_oz if agg_s_oz > 0 else 0

    return jsonify({
        'entity':   entity,
        'metal':    metal,
        'spot_zar': spot,

        # Open book entering this period — shown in Provision block when non-zero
        'carry_in': carry_in,

        'buy_side': {
            'oz':      round(agg_b_oz,       4),
            'val':     round(agg_b_val,      2),
            'vwap':    round(agg_buy_vwap,   2),
            'buy_oz':  round(buy_oz,         4),
            'long_oz': round(long_oz,        4),
        },
        'sell_side': {
            'oz':       round(agg_s_oz,       4),
            'val':      round(agg_s_val,      2),
            'vwap':     round(agg_sell_vwap,  2),
            'sell_oz':  round(sell_oz,        4),
            'short_oz': round(short_oz,       4),
        },
        'matched_oz':      round(total_matched,  4),
        'treasury_alpha':  round(realized_alpha, 2),
        'unrealized_mtm':  round(unrealized_mtm, 2),
        'net_oz':          round(net_oz,         4),
        'open_long_vwap':  round(open_long_vwap,  2),
        'open_short_vwap': round(open_short_vwap, 2),
        'open_long_oz':    round(open_long_oz,    4),
        'open_short_oz':   round(open_short_oz,   4),
    })


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
# GOLDSTORE API PROXY
# ─────────────────────────────────────────────

import requests as _requests

_GOLDSTORE_BASE = 'https://api.goldstore.co.za/api/v1'
_GOLDSTORE_HEADERS = {'Accept': 'application/json'}

@app.route('/api/goldstore/products')
def goldstore_products():
    """Proxy: GoldStore products list (paginated)."""
    page = request.args.get('page', 1)
    resp = _requests.get(
        f'{_GOLDSTORE_BASE}/products/list',
        params={'page': page},
        headers=_GOLDSTORE_HEADERS,
        timeout=10
    )
    return (resp.content, resp.status_code, {'Content-Type': 'application/json'})


@app.route('/api/goldstore/live-price')
def goldstore_live_price():
    """Proxy: GoldStore live price."""
    resp = _requests.get(
        f'{_GOLDSTORE_BASE}/market/live-price',
        headers=_GOLDSTORE_HEADERS,
        timeout=10
    )
    return (resp.content, resp.status_code, {'Content-Type': 'application/json'})


@app.route('/api/spot/debug')
def spot_debug():
    """Debug: show parsed GoldStore live-price values."""
    try:
        resp = _requests.get(
            f'{_GOLDSTORE_BASE}/market/live-price',
            headers=_GOLDSTORE_HEADERS,
            timeout=10
        )
        data_list = resp.json().get('data', [])
        entry = next((d for d in data_list if d.get('isCurrent')), None) or (data_list[0] if data_list else {})
        rates = entry.get('rates', {})
        zar = rates.get('ZAR', 0)
        return jsonify({
            'http_status':   resp.status_code,
            'date':          entry.get('date'),
            'isCurrent':     entry.get('isCurrent'),
            'gold_zar_oz':   round(rates.get('USDXAU', 0) * zar, 2),
            'silver_zar_oz': round(rates.get('USDXAG', 0) * zar, 2),
        })
    except Exception as e:
        return jsonify({'error': str(e), 'type': type(e).__name__}), 500


# ─────────────────────────────────────────────
# INVENTORY MANAGEMENT
# ─────────────────────────────────────────────

@app.route('/api/inv/products')
def inv_products_endpoint():
    metal    = request.args.get('metal', 'gold')
    category = request.args.get('category', 'bullion')
    conn = models.get_conn()
    rows = conn.execute(
        "SELECT * FROM inv_products WHERE metal=? AND category=? AND active=1 ORDER BY display_order, product_name",
        (metal, category)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/inv/snapshot')
def inv_snapshot_endpoint():
    entity   = request.args.get('entity',   'SABIS')
    metal    = request.args.get('metal',    'gold')
    category = request.args.get('category', 'bullion')
    date_str = request.args.get('date',     '')
    try:
        data = models.get_inv_snapshot(entity, metal, category, date_str or None)
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/inv/opening', methods=['PUT'])
def inv_opening_endpoint():
    body = request.get_json() or {}
    entity    = body.get('entity', 'SABIS')
    sage_code = body.get('sage_code')
    bal_date  = body.get('balance_date')
    eaches    = body.get('eaches', 0.0)
    notes     = body.get('notes', '')
    if not sage_code or not bal_date:
        return jsonify({'error': 'sage_code and balance_date required'}), 400
    conn = models.get_conn()
    conn.execute("""
        INSERT INTO inv_opening_balance (entity, sage_code, balance_date, eaches, notes)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(entity, sage_code, balance_date) DO UPDATE SET eaches=excluded.eaches, notes=excluded.notes
    """, (entity, sage_code, bal_date, eaches, notes))
    conn.commit()
    conn.close()
    return jsonify({'status': 'ok'})


@app.route('/api/inv/physical', methods=['GET', 'PUT'])
def inv_physical_endpoint():
    if request.method == 'GET':
        entity    = request.args.get('entity',   'SABIS')
        metal     = request.args.get('metal',    'gold')
        category  = request.args.get('category', 'bullion')
        conn = models.get_conn()
        rows = conn.execute("""
            SELECT p.*, i.metal, i.category FROM inv_physical p
            JOIN inv_products i ON i.sage_code = p.sage_code
            WHERE p.entity=? AND i.metal=? AND i.category=?
            AND p.record_date = (SELECT MAX(record_date) FROM inv_physical WHERE entity=p.entity AND sage_code=p.sage_code)
        """, (entity, metal, category)).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
    else:
        body      = request.get_json() or {}
        entity    = body.get('entity', 'SABIS')
        sage_code = body.get('sage_code')
        rec_date  = body.get('record_date')
        if not sage_code or not rec_date:
            return jsonify({'error': 'sage_code and record_date required'}), 400
        conn = models.get_conn()
        conn.execute("""
            INSERT INTO inv_physical (entity, sage_code, record_date, outstanding_collections,
              custody_storage_ledger, awaiting_delivery, expected_physical, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity, sage_code, record_date) DO UPDATE SET
              outstanding_collections=excluded.outstanding_collections,
              custody_storage_ledger=excluded.custody_storage_ledger,
              awaiting_delivery=excluded.awaiting_delivery,
              expected_physical=excluded.expected_physical,
              notes=excluded.notes, updated_at=datetime('now')
        """, (entity, sage_code, rec_date,
              body.get('outstanding_collections', 0),
              body.get('custody_storage_ledger', 0),
              body.get('awaiting_delivery', 0),
              body.get('expected_physical', 0),
              body.get('notes', '')))
        conn.commit()
        conn.close()
        return jsonify({'status': 'ok'})


@app.route('/api/inv/sage', methods=['GET', 'PUT'])
def inv_sage_endpoint():
    if request.method == 'GET':
        entity   = request.args.get('entity',   'SABIS')
        metal    = request.args.get('metal',    'gold')
        category = request.args.get('category', 'bullion')
        conn = models.get_conn()
        rows = conn.execute("""
            SELECT s.*, i.metal, i.category FROM inv_sage_recon s
            JOIN inv_products i ON i.sage_code = s.sage_code
            WHERE s.entity=? AND i.metal=? AND i.category=?
        """, (entity, metal, category)).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
    else:
        body      = request.get_json() or {}
        entity    = body.get('entity', 'SABIS')
        sage_code = body.get('sage_code')
        rec_date  = body.get('record_date')
        if not sage_code or not rec_date:
            return jsonify({'error': 'sage_code and record_date required'}), 400
        conn = models.get_conn()
        conn.execute("""
            INSERT INTO inv_sage_recon (entity, sage_code, record_date, sage_eaches, notes)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(entity, sage_code, record_date) DO UPDATE SET
              sage_eaches=excluded.sage_eaches, notes=excluded.notes, updated_at=datetime('now')
        """, (entity, sage_code, rec_date, body.get('sage_eaches', 0), body.get('notes', '')))
        conn.commit()
        conn.close()
        return jsonify({'status': 'ok'})


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    # Migrate: create funding_costs if this is an existing DB
    import sqlite3 as _sq
    _conn = _sq.connect(models.DB_PATH)
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS funding_costs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            entity      TEXT NOT NULL,
            metal       TEXT NOT NULL CHECK(metal IN ('gold','silver')),
            platform    TEXT NOT NULL DEFAULT 'Stone X',
            cost_type   TEXT NOT NULL CHECK(cost_type IN ('swap_fee','interest_earned')),
            amount_zar  REAL NOT NULL,
            charge_date TEXT NOT NULL,
            notes       TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        )""")
    _conn.commit(); _conn.close()
    os.makedirs(INBOX_DIR, exist_ok=True)
    print("Treasury Brain server starting on http://localhost:5000")
    app.run(debug=True, host='0.0.0.0', port=5000)
