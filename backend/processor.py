"""
Treasury Brain — Core Calculation Engine
Handles: VWAP, GP, margin vs provision, live impact preview,
         provision mode detection, dormancy tracking, silo/channel analytics
"""

import json
import os
from datetime import datetime, date

# Load config
CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'settings.json')
with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

PROVISION_RATES = CONFIG['provision_rates']          # gold: 4.5, silver: 8.0
DORMANCY_DAYS   = CONFIG['dormancy_threshold_days']  # 14


# ─────────────────────────────────────────────
# PROVISION MODE
# ─────────────────────────────────────────────

def get_provision_mode(inventory_oz: float, metal: str) -> dict:
    """
    Returns current provision mode and rate for a given inventory level.

    Inventory < 0  → PROVISION active  (company is short — float position)
    Inventory >= 0 → NO PROVISION      (stock on hand)

    The provision rate (gold 4.5%, silver 8%) is the business hurdle rate.
    It is ALWAYS used as the GP baseline regardless of inventory sign,
    because every deal must be measured against this cost of capital —
    not just when the company is short.  The 'active' flag tells you
    whether the rate is actually being charged on the float today.
    """
    active = inventory_oz < 0
    rate   = PROVISION_RATES.get(metal, 0)   # always the full rate — the hurdle
    return {
        'active':    active,
        'mode':      'PROVISION' if active else 'NO PROVISION',
        'rate_pct':  rate,
        'inventory': inventory_oz,
    }


def would_flip_provision(current_inventory_oz: float, deal_oz: float, deal_type: str) -> bool:
    """
    Returns True if this deal would push inventory across the 0oz threshold,
    triggering a provision mode change.
    deal_type: 'buy' (adds to inventory) or 'sell' (removes from inventory)
    """
    delta = deal_oz if deal_type == 'buy' else -deal_oz
    new_inventory = current_inventory_oz + delta
    return (current_inventory_oz >= 0 and new_inventory < 0) or \
           (current_inventory_oz < 0  and new_inventory >= 0)


# ─────────────────────────────────────────────
# VWAP CALCULATIONS
# ─────────────────────────────────────────────

def calc_vwap(total_deal_value: float, total_oz: float) -> float:
    """Running VWAP = total deal value ZAR / total oz"""
    if total_oz == 0:
        return 0.0
    return total_deal_value / total_oz


def calc_margin_vwap(deals: list) -> float:
    """
    Margin VWAP for a set of deals = Σ(margin_pct × oz) / Σ(oz)
    deals: list of dicts with keys 'margin_pct' and 'oz'
    """
    total_oz = sum(d['oz'] for d in deals)
    if total_oz == 0:
        return 0.0
    return sum(d['margin_pct'] * d['oz'] for d in deals) / total_oz


def vwap_after_deal(
    current_total_value: float,
    current_total_oz:    float,
    deal_value:          float,
    deal_oz:             float,
    deal_type:           str
) -> float:
    """
    Calculates the new running VWAP if this deal is added.
    For buys:  adds to running totals
    For sells: removes from running totals (reduces position)
    """
    if deal_type == 'buy':
        return calc_vwap(current_total_value + deal_value,
                         current_total_oz    + deal_oz)
    else:
        return calc_vwap(max(current_total_value - deal_value, 0),
                         max(current_total_oz    - deal_oz,    0))


# ─────────────────────────────────────────────
# MARGIN vs PROVISION
# ─────────────────────────────────────────────

def margin_vs_provision(margin_pct: float, provision_pct: float, deal_type: str) -> dict:
    """
    Calculates profit margin relative to provision for a single deal.

    The provision rate is the business hurdle rate (gold 4.5%, silver 8%).
    Every deal is measured against it — not just when in provision mode.

    SELLS:
        Company sells to client at spot + margin%.
        Profit vs provision = margin% − provision%.
        Positive → sale margin clears the provision hurdle (profitable).
        Example: sell at 5%, provision 4.5% → profit = +0.5%

    BUYS (buybacks from clients):
        Company buys from client at spot − margin%.
        Profit vs provision = provision% − margin%.
        Positive → buying below the provision rate (profitable buyback).
        Example: buy at 2%, provision 4.5% → profit = +2.5%
        (company covers its position for less than the provision cost)
    """
    if deal_type == 'sell':
        profit_pct = margin_pct - provision_pct
        label      = 'margin over provision'
    else:  # buy / buyback
        profit_pct = provision_pct - margin_pct
        label      = 'margin under provision'

    return {
        'profit_pct':    round(profit_pct, 4),
        'profitable':    profit_pct > 0,
        'label':         label,
        'margin_pct':    margin_pct,
        'provision_pct': provision_pct,
    }


# ─────────────────────────────────────────────
# GP CONTRIBUTION
# ─────────────────────────────────────────────

def calc_gp_contribution(profit_pct: float, net_deal_value_zar: float) -> float:
    """
    GP contribution = profit margin % × net deal value (ZAR)
    profit_pct is expressed as a percentage e.g. 2.0 = 2%
    """
    return (profit_pct / 100) * net_deal_value_zar


# ─────────────────────────────────────────────
# LIVE IMPACT PREVIEW (what-if per deal)
# ─────────────────────────────────────────────

def live_impact_preview(
    deal: dict,
    current_state: dict,
    provision_pct: float
) -> dict:
    """
    Given a proposed deal (not yet confirmed), returns the full impact:
    - New VWAP
    - New inventory level
    - Cash flow
    - Provision mode change
    - Margin vs provision
    - GP contribution

    deal = {
        'type':       'buy' | 'sell',
        'oz':         float,
        'spot_price': float,       # ZAR per oz
        'margin_pct': float,       # % over/under spot (negative = below spot)
        'metal':      'gold' | 'silver',
    }
    current_state = {
        'total_value_zar': float,  # running total deal value
        'total_oz':        float,  # running total oz
        'inventory_oz':    float,  # current ecosystem inventory
        'cash_zar':        float,  # current cash position
    }
    """
    oz          = deal['oz']
    spot        = deal['spot_price']
    margin_pct  = deal['margin_pct']
    deal_type   = deal['type']
    metal       = deal['metal']

    # Effective price:
    #   Sells: company charges client above spot → spot × (1 + margin%)
    #   Buys:  company pays client below spot    → spot × (1 − margin%)
    if deal_type == 'sell':
        effective_price = spot * (1 + margin_pct / 100)
    else:
        effective_price = spot * (1 - margin_pct / 100)

    deal_value = effective_price * oz

    # Margin vs provision
    mvp = margin_vs_provision(margin_pct, provision_pct, deal_type)

    # GP uses notional (spot × oz) as base so buy/sell GP are directly comparable
    notional = spot * oz
    gp = calc_gp_contribution(mvp['profit_pct'], notional)

    # Cash flow: buy = cash out (negative), sell = cash in (positive)
    cash_delta = deal_value if deal_type == 'sell' else -deal_value

    # New inventory
    inv_delta    = oz if deal_type == 'buy' else -oz
    new_inventory = current_state['inventory_oz'] + inv_delta

    # New VWAP
    new_vwap = vwap_after_deal(
        current_state['total_value_zar'],
        current_state['total_oz'],
        deal_value,
        oz,
        deal_type
    )

    # Provision mode before and after
    mode_before = get_provision_mode(current_state['inventory_oz'], metal)
    mode_after  = get_provision_mode(new_inventory, metal)
    flips       = mode_before['active'] != mode_after['active']

    # Exposure delta: long exposure increases on buys, decreases on sells
    exposure_delta = oz * spot if deal_type == 'buy' else -(oz * spot)

    return {
        'deal_value_zar':       round(deal_value, 2),
        'effective_price':      round(effective_price, 2),
        'margin_vs_provision':  mvp,
        'gp_contribution_zar':  round(gp, 2),
        'cash_delta_zar':       round(cash_delta, 2),
        'new_cash_zar':         round(current_state['cash_zar'] + cash_delta, 2),
        'new_inventory_oz':     round(new_inventory, 6),
        'inventory_delta_oz':   round(inv_delta, 6),
        'new_vwap':             round(new_vwap, 2),
        'exposure_delta_zar':   round(exposure_delta, 2),
        'provision_before':     mode_before,
        'provision_after':      mode_after,
        'provision_flips':      flips,
        'flip_alert':           '⚠ This deal changes provision mode!' if flips else None,
    }


# ─────────────────────────────────────────────
# DORMANCY / INVENTORY AGEING
# ─────────────────────────────────────────────

def flag_dormant(acquired_date: date, threshold_days: int = DORMANCY_DAYS) -> dict:
    """
    Returns dormancy status for an inventory parcel.
    acquired_date: date the oz were acquired
    """
    days_held = (date.today() - acquired_date).days
    flagged   = days_held >= threshold_days
    return {
        'days_held':       days_held,
        'flagged':         flagged,
        'threshold_days':  threshold_days,
        'status':          'SLOW-MOVING' if flagged else 'ACTIVE',
        'action':          'Review for exit opportunity' if flagged else None,
    }


def optimal_exit_suggestion(parcel: dict, current_spot: float, provision_pct: float) -> str:
    """
    Suggests exit action for a dormant inventory parcel.
    parcel = { 'oz': float, 'cost_price_zar': float, 'days_held': int, 'metal': str }
    """
    cost_per_oz    = parcel['cost_price_zar'] / parcel['oz']
    break_even_pct = ((cost_per_oz / current_spot) - 1) * 100
    over_provision = provision_pct - break_even_pct

    if over_provision > 0:
        return (f"Sell now profitable: breakeven at spot {break_even_pct:+.2f}%, "
                f"provision covers {over_provision:.2f}% above breakeven. "
                f"Held {parcel['days_held']} days.")
    else:
        return (f"Hold: breakeven at spot {break_even_pct:+.2f}% exceeds provision. "
                f"Need spot to move {abs(over_provision):.2f}% higher. "
                f"Held {parcel['days_held']} days.")


# ─────────────────────────────────────────────
# SILO / CHANNEL ANALYTICS
# ─────────────────────────────────────────────

def calc_silo_analytics(deals: list) -> dict:
    """
    Aggregates GP contribution, deal count, oz, and VWAP margins
    broken down by silo (retail / wholesale / custody).
    deals: list of deal dicts with keys:
        silo, deal_type, oz, deal_value_zar, gp_contribution_zar, margin_pct
    """
    silos = {}
    total_gp = sum(d.get('gp_contribution_zar', 0) for d in deals)

    for deal in deals:
        silo = deal.get('silo', 'unknown')
        if silo not in silos:
            silos[silo] = {
                'deal_count': 0, 'total_oz': 0,
                'total_value_zar': 0, 'gp_contribution_zar': 0,
                'buy_margins': [], 'sell_margins': [],
            }
        s = silos[silo]
        s['deal_count']          += 1
        s['total_oz']            += deal.get('oz', 0)
        s['total_value_zar']     += deal.get('deal_value_zar', 0)
        s['gp_contribution_zar'] += deal.get('gp_contribution_zar', 0)

        if deal.get('deal_type') == 'buy':
            s['buy_margins'].append({'oz': deal['oz'], 'margin_pct': deal['margin_pct']})
        else:
            s['sell_margins'].append({'oz': deal['oz'], 'margin_pct': deal['margin_pct']})

    # Calculate derived metrics per silo
    for silo, s in silos.items():
        s['gp_proportion_pct'] = round(
            (s['gp_contribution_zar'] / total_gp * 100) if total_gp else 0, 2)
        s['buy_vwap_margin']  = round(calc_margin_vwap(s['buy_margins']),  4)
        s['sell_vwap_margin'] = round(calc_margin_vwap(s['sell_margins']), 4)
        s['vwap']             = calc_vwap(s['total_value_zar'], s['total_oz'])
        del s['buy_margins'], s['sell_margins']  # clean up working lists

    return silos


def calc_channel_analytics(deals: list) -> dict:
    """
    Same as silo analytics but broken down by channel (digital / dealer).
    """
    channels  = {}
    total_gp  = sum(d.get('gp_contribution_zar', 0) for d in deals)

    for deal in deals:
        ch = deal.get('channel', 'unknown')
        if ch not in channels:
            channels[ch] = {
                'deal_count': 0, 'total_oz': 0,
                'total_value_zar': 0, 'gp_contribution_zar': 0,
                'buy_margins': [], 'sell_margins': [],
            }
        c = channels[ch]
        c['deal_count']          += 1
        c['total_oz']            += deal.get('oz', 0)
        c['total_value_zar']     += deal.get('deal_value_zar', 0)
        c['gp_contribution_zar'] += deal.get('gp_contribution_zar', 0)

        if deal.get('deal_type') == 'buy':
            c['buy_margins'].append({'oz': deal['oz'], 'margin_pct': deal['margin_pct']})
        else:
            c['sell_margins'].append({'oz': deal['oz'], 'margin_pct': deal['margin_pct']})

    for ch, c in channels.items():
        c['gp_proportion_pct'] = round(
            (c['gp_contribution_zar'] / total_gp * 100) if total_gp else 0, 2)
        c['buy_vwap_margin']  = round(calc_margin_vwap(c['buy_margins']),  4)
        c['sell_vwap_margin'] = round(calc_margin_vwap(c['sell_margins']), 4)
        c['vwap']             = calc_vwap(c['total_value_zar'], c['total_oz'])
        del c['buy_margins'], c['sell_margins']

    return channels


# ─────────────────────────────────────────────
# DAILY SUMMARY
# ─────────────────────────────────────────────

def build_daily_summary(entity: str, metal: str, deals: list,
                         inventory_oz: float, spot_price: float) -> dict:
    """
    Builds the full daily summary for one entity + metal combination.
    """
    buys  = [d for d in deals if d.get('deal_type') == 'buy']
    sells = [d for d in deals if d.get('deal_type') == 'sell']

    total_buy_oz    = sum(d['oz'] for d in buys)
    total_sell_oz   = sum(d['oz'] for d in sells)
    total_buy_val   = sum(d['deal_value_zar'] for d in buys)
    total_sell_val  = sum(d['deal_value_zar'] for d in sells)
    total_gp        = sum(d.get('gp_contribution_zar', 0) for d in deals)

    buy_vwap  = calc_vwap(total_buy_val,  total_buy_oz)
    sell_vwap = calc_vwap(total_sell_val, total_sell_oz)

    buy_margin_vwap  = calc_margin_vwap(
        [{'oz': d['oz'], 'margin_pct': d['margin_pct']} for d in buys])
    sell_margin_vwap = calc_margin_vwap(
        [{'oz': d['oz'], 'margin_pct': d['margin_pct']} for d in sells])

    provision = get_provision_mode(inventory_oz, metal)

    return {
        'entity':            entity,
        'metal':             metal,
        'date':              date.today().isoformat(),
        'deal_count':        len(deals),
        'buy_oz':            round(total_buy_oz,   6),
        'sell_oz':           round(total_sell_oz,  6),
        'buy_value_zar':     round(total_buy_val,  2),
        'sell_value_zar':    round(total_sell_val, 2),
        'buy_vwap':          round(buy_vwap,        2),
        'sell_vwap':         round(sell_vwap,       2),
        'buy_margin_vwap':   round(buy_margin_vwap,  4),
        'sell_margin_vwap':  round(sell_margin_vwap, 4),
        'total_gp_zar':      round(total_gp,        2),
        'inventory_oz':      round(inventory_oz,    6),
        'spot_price_zar':    spot_price,
        'inventory_value_zar': round(inventory_oz * spot_price, 2),
        'provision_mode':    provision,
        'silo_analytics':    calc_silo_analytics(deals),
        'channel_analytics': calc_channel_analytics(deals),
    }
