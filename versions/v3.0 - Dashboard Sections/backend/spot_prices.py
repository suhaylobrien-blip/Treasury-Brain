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


GOLDSTORE_LIVE_URL = 'https://api.goldstore.co.za/api/v1/market/live-price'

# GoldStore symbol map: metal -> key in data.rates (USD price per oz)
GOLDSTORE_SYMBOLS = {
    'gold':   'USDXAU',
    'silver': 'USDXAG',
}

_last_zar_rate = 0.0  # ZAR per 1 USD, cached from last GoldStore fetch


def get_zar_rate() -> float:
    """Return the last fetched ZAR/USD exchange rate."""
    return _last_zar_rate


def _fetch_from_goldstore(metal: str) -> float:
    """Fetch ZAR spot price from GoldStore live-price API."""
    usd_key = GOLDSTORE_SYMBOLS.get(metal.lower())
    if not usd_key:
        return 0.0
    try:
        resp = requests.get(GOLDSTORE_LIVE_URL, timeout=10)
        data_list = resp.json().get('data', [])
        # data is a list of daily entries — pick the current one
        entry = next((d for d in data_list if d.get('isCurrent')), None) or (data_list[0] if data_list else {})
        rates = entry.get('rates', {})
        usd_per_oz = rates.get(usd_key)
        zar_per_usd = rates.get('ZAR')
        if usd_per_oz and zar_per_usd:
            global _last_zar_rate
            _last_zar_rate = zar_per_usd
            price_zar = usd_per_oz * zar_per_usd
            insert_spot_price(metal, price_zar, source='goldstore')
            print(f"[spot_prices] {metal.title()} spot: R{price_zar:,.2f}/oz (GoldStore)")
            return price_zar
    except Exception as e:
        print(f"[spot_prices] GoldStore fetch failed: {e}")
    return 0.0


def fetch_live_spot(metal: str) -> float:
    """
    Fetches the latest spot price for a metal in ZAR.
    Uses metals-api if an API key is configured, otherwise falls back to
    GoldStore live-price API. Returns last DB price if both fail.
    """
    symbol = SYMBOLS.get(metal.lower())
    if not symbol:
        raise ValueError(f"Unknown metal: {metal}")

    if not API_KEY:
        price = _fetch_from_goldstore(metal)
        if price:
            return price
        print(f"[spot_prices] GoldStore unavailable — returning last DB price for {metal}")
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
