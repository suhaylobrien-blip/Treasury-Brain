"""
Treasury Brain — Spot Price Fetcher
Fetches live gold/silver prices in ZAR from metals-api or fallback sources.
"""

import json
import os
import requests
from datetime import datetime
from models import insert_spot_price, get_latest_spot

CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'settings.json')
with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

API_KEY  = CONFIG.get('spot_price_api_key', '')
CURRENCY = CONFIG.get('spot_price_currency', 'ZAR')

# Metals-API symbols
SYMBOLS = {
    'gold':   'XAU',
    'silver': 'XAG',
}


def fetch_live_spot(metal: str) -> float:
    """
    Fetches the latest spot price for a metal in ZAR.
    Returns 0.0 if unavailable. Falls back to last DB price.
    """
    symbol = SYMBOLS.get(metal.lower())
    if not symbol:
        raise ValueError(f"Unknown metal: {metal}")

    if not API_KEY:
        print(f"[spot_prices] No API key configured — returning last DB price for {metal}")
        return get_latest_spot(metal)

    try:
        url = f"https://metals-api.com/api/latest?access_key={API_KEY}&base={CURRENCY}&symbols={symbol}"
        resp = requests.get(url, timeout=10)
        data = resp.json()

        if not data.get('success'):
            print(f"[spot_prices] API error: {data.get('error', {}).get('info', 'unknown')}")
            return get_latest_spot(metal)

        # metals-api returns ZAR per troy oz relative to base
        # When base=ZAR, rate for XAU = ZAR per 1 oz gold
        rate = data['rates'].get(symbol)
        if rate:
            price_zar = 1 / rate  # convert: ZAR/XAU
            insert_spot_price(metal, price_zar, source='metals-api')
            print(f"[spot_prices] {metal.title()} spot: R{price_zar:,.2f}/oz (live)")
            return price_zar

    except Exception as e:
        print(f"[spot_prices] Fetch failed: {e}")

    return get_latest_spot(metal)


def fetch_all_spots() -> dict:
    """Fetch and store spot prices for all metals. Returns dict of {metal: price_zar}."""
    results = {}
    for metal in CONFIG.get('metals', ['gold', 'silver']):
        results[metal] = fetch_live_spot(metal)
    return results


def manual_spot_entry(metal: str, price_zar: float):
    """Manually record a spot price (e.g. from a Reuters screen or dealer quote)."""
    insert_spot_price(metal, price_zar, source='manual')
    print(f"[spot_prices] Manual spot recorded: {metal} @ R{price_zar:,.2f}/oz")


if __name__ == '__main__':
    prices = fetch_all_spots()
    for metal, price in prices.items():
        print(f"  {metal.title()}: R{price:,.2f}/oz")
