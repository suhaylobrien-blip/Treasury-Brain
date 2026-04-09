"""
Treasury Brain — Database Layer (SQLite)
Single source of truth for all deal, inventory, hedging, cash flow and bank data.
"""

import hashlib
import sqlite3
import os
from datetime import date

# Store DB in local AppData to avoid OneDrive sync conflicts with SQLite file locking
_LOCAL_DATA = os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'TreasuryBrain')
os.makedirs(_LOCAL_DATA, exist_ok=True)
DB_PATH = os.path.join(_LOCAL_DATA, 'treasury.db')


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """Create all tables if they don't exist."""
    conn = get_conn()
    c = conn.cursor()

    # ── DEALS ────────────────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS deals (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        entity               TEXT    NOT NULL CHECK(entity IN ('SABIS','SABI','SABGB')),
        metal                TEXT    NOT NULL CHECK(metal IN ('gold','silver')),
        deal_type            TEXT    NOT NULL CHECK(deal_type IN ('buy','sell')),
        deal_date            TEXT    NOT NULL,
        dealer_name          TEXT,
        silo                 TEXT    NOT NULL CHECK(silo IN ('retail','wholesale','custody')),
        channel              TEXT    NOT NULL CHECK(channel IN ('digital','dealer')),
        product_code         TEXT,
        product_name         TEXT,
        equiv_oz_per_unit    REAL    NOT NULL DEFAULT 1.0,
        units                REAL    NOT NULL,
        oz                   REAL    NOT NULL,
        spot_price_zar       REAL    NOT NULL,
        margin_pct           REAL    NOT NULL,
        effective_price_zar  REAL    NOT NULL,
        deal_value_zar       REAL    NOT NULL,
        provision_pct        REAL    NOT NULL DEFAULT 0.0,
        profit_margin_pct    REAL    NOT NULL DEFAULT 0.0,
        gp_contribution_zar  REAL    NOT NULL DEFAULT 0.0,
        -- running totals at point of capture
        running_total_oz     REAL,
        running_total_value  REAL,
        running_vwap         REAL,
        margin_vwap_day      REAL,
        -- impact at capture
        inventory_after_oz   REAL,
        provision_flipped    INTEGER DEFAULT 0,
        source_file          TEXT,
        created_at           TEXT    DEFAULT (datetime('now')),
        -- deal classification from row colour in Excel
        status               TEXT    DEFAULT 'confirmed',  -- confirmed | quote | proof
        product_type         TEXT    DEFAULT 'bullion'     -- bullion | proof
    )""")

    # ── MIGRATE existing DB: add new columns if absent ───────────────────
    for col, definition in [
        ('status',       "TEXT DEFAULT 'confirmed'"),
        ('product_type', "TEXT DEFAULT 'bullion'"),
        ('deal_hash',    "TEXT"),
    ]:
        try:
            c.execute(f"ALTER TABLE deals ADD COLUMN {col} {definition}")
        except Exception:
            pass  # column already exists
    try:
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_hash ON deals(deal_hash) WHERE deal_hash IS NOT NULL")
    except Exception:
        pass

    # ── PIPELINE (quotes — yellow rows) ──────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS pipeline (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        entity          TEXT    NOT NULL,
        metal           TEXT    NOT NULL,
        deal_type       TEXT    NOT NULL,
        deal_date       TEXT,
        client_name     TEXT,
        product_name    TEXT,
        product_code    TEXT,
        units           REAL,
        oz              REAL,
        spot_price_zar  REAL,
        margin_pct      REAL,
        deal_value_zar  REAL,
        product_type    TEXT    DEFAULT 'bullion',
        source_file     TEXT,
        created_at      TEXT    DEFAULT (datetime('now'))
    )""")

    # ── INVENTORY ────────────────────────────────────────────────────────
    # One row per entity+metal — updated on every deal
    c.execute("""
    CREATE TABLE IF NOT EXISTS inventory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity      TEXT NOT NULL,
        metal       TEXT NOT NULL,
        total_oz    REAL NOT NULL DEFAULT 0.0,
        updated_at  TEXT DEFAULT (datetime('now')),
        UNIQUE(entity, metal)
    )""")

    # ── INVENTORY AGEING (one row per acquired parcel) ───────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS inventory_ageing (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        entity          TEXT NOT NULL,
        metal           TEXT NOT NULL,
        deal_id         INTEGER REFERENCES deals(id),
        acquired_date   TEXT NOT NULL,
        oz              REAL NOT NULL,
        cost_price_zar  REAL NOT NULL,
        days_held       INTEGER,
        flagged         INTEGER DEFAULT 0,
        status          TEXT DEFAULT 'ACTIVE',
        disposed        INTEGER DEFAULT 0,
        disposed_date   TEXT
    )""")

    # ── HEDGING ──────────────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS hedging (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        entity          TEXT NOT NULL,
        metal           TEXT NOT NULL,
        position_type   TEXT NOT NULL CHECK(position_type IN ('long','short')),
        open_date       TEXT NOT NULL,
        close_date      TEXT,
        contract_oz     REAL NOT NULL,
        open_price_zar  REAL NOT NULL,
        close_price_zar REAL,
        pnl_zar         REAL,
        platform        TEXT,
        notes           TEXT,
        status          TEXT DEFAULT 'open' CHECK(status IN ('open','closed')),
        created_at      TEXT DEFAULT (datetime('now'))
    )""")

    # ── SPOT PRICES ──────────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS spot_prices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        metal       TEXT NOT NULL,
        price_zar   REAL NOT NULL,
        source      TEXT,
        recorded_at TEXT DEFAULT (datetime('now'))
    )""")

    # ── DAILY SUMMARY ────────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS daily_summary (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        entity               TEXT NOT NULL,
        metal                TEXT NOT NULL,
        summary_date         TEXT NOT NULL,
        deal_count           INTEGER,
        buy_oz               REAL,
        sell_oz              REAL,
        buy_value_zar        REAL,
        sell_value_zar       REAL,
        buy_vwap             REAL,
        sell_vwap            REAL,
        buy_margin_vwap      REAL,
        sell_margin_vwap     REAL,
        total_gp_zar         REAL,
        inventory_oz         REAL,
        spot_price_zar       REAL,
        inventory_value_zar  REAL,
        provision_active     INTEGER,
        provision_rate_pct   REAL,
        UNIQUE(entity, metal, summary_date)
    )""")

    # ── CASH FLOWS ───────────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS cash_flows (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        entity          TEXT NOT NULL,
        flow_date       TEXT NOT NULL,
        flow_type       TEXT NOT NULL CHECK(flow_type IN ('deal','hedge','manual')),
        direction       TEXT NOT NULL CHECK(direction IN ('in','out')),
        amount_zar      REAL NOT NULL,
        description     TEXT,
        deal_id         INTEGER REFERENCES deals(id),
        hedge_id        INTEGER REFERENCES hedging(id),
        reconciled      INTEGER DEFAULT 0,
        created_at      TEXT DEFAULT (datetime('now'))
    )""")

    # ── BANK ACCOUNTS ────────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS bank_accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        entity       TEXT NOT NULL,
        bank_name    TEXT NOT NULL CHECK(bank_name IN ('ABSA','FNB','Nedbank','Standard Bank')),
        account_name TEXT,
        account_no   TEXT,
        currency     TEXT DEFAULT 'ZAR'
    )""")

    # ── BANK TRANSACTIONS (imported statements) ───────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS bank_transactions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      INTEGER REFERENCES bank_accounts(id),
        txn_date        TEXT NOT NULL,
        description     TEXT,
        amount_zar      REAL NOT NULL,
        balance_zar     REAL,
        bank_reference  TEXT,
        recon_status    TEXT DEFAULT 'unmatched' CHECK(recon_status IN ('matched','unmatched','pending','ignored')),
        cash_flow_id    INTEGER REFERENCES cash_flows(id),
        imported_at     TEXT DEFAULT (datetime('now'))
    )""")

    # ── RECONCILIATION ───────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS reconciliation (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        bank_txn_id      INTEGER REFERENCES bank_transactions(id),
        cash_flow_id     INTEGER REFERENCES cash_flows(id),
        matched_at       TEXT DEFAULT (datetime('now')),
        match_type       TEXT CHECK(match_type IN ('auto','manual')),
        notes            TEXT
    )""")

    conn.commit()
    conn.close()
    print(f"Database initialised at: {DB_PATH}")


# ─────────────────────────────────────────────
# DEAL OPERATIONS
# ─────────────────────────────────────────────

def reset_entity_data(entity: str, metal: str):
    """
    Wipe all deals, inventory, pipeline, cash flows, and ageing parcels
    for a given entity + metal combination so data can be re-imported
    with corrected calculations.
    """
    conn = get_conn()
    c    = conn.cursor()
    c.execute("DELETE FROM deals            WHERE entity=? AND metal=?", (entity, metal))
    c.execute("DELETE FROM pipeline         WHERE entity=? AND metal=?", (entity, metal))
    c.execute("DELETE FROM inventory        WHERE entity=? AND metal=?", (entity, metal))
    c.execute("DELETE FROM inventory_ageing WHERE entity=? AND metal=?", (entity, metal))
    c.execute("DELETE FROM cash_flows       WHERE entity=?",             (entity,))
    conn.commit()
    conn.close()


def insert_pipeline(record: dict) -> int:
    conn = get_conn()
    c    = conn.cursor()
    cols = ', '.join(record.keys())
    phs  = ', '.join(['?'] * len(record))
    c.execute(f"INSERT INTO pipeline ({cols}) VALUES ({phs})", list(record.values()))
    row_id = c.lastrowid
    conn.commit()
    conn.close()
    return row_id


def get_pipeline(entity: str, metal: str,
                 from_date: str = None, to_date: str = None) -> list:
    conn   = get_conn()
    c      = conn.cursor()
    params = [entity, metal]
    where  = "entity=? AND metal=?"
    if from_date:
        where += " AND deal_date >= ?"; params.append(from_date)
    if to_date:
        where += " AND deal_date <= ?"; params.append(to_date)
    c.execute(f"SELECT * FROM pipeline WHERE {where} ORDER BY deal_date ASC, id ASC", params)
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows


def delete_pipeline_row(pipeline_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM pipeline WHERE id=?", (pipeline_id,))
    conn.commit()
    conn.close()


def _make_deal_hash(deal: dict) -> str:
    """Stable fingerprint for deduplication — same deal = same hash."""
    key = '|'.join(str(deal.get(f, '')) for f in [
        'entity', 'metal', 'deal_type', 'deal_date',
        'dealer_name', 'product_code', 'units', 'spot_price_zar', 'margin_pct',
    ])
    return hashlib.md5(key.encode()).hexdigest()


def insert_deal(deal: dict) -> int:
    """Insert a deal. Returns existing id if an identical deal already exists (dedup)."""
    deal_hash = _make_deal_hash(deal)
    deal      = {**deal, 'deal_hash': deal_hash}   # attach hash to record

    conn = get_conn()
    c    = conn.cursor()

    # Deduplication check — same fingerprint = same deal, skip insert
    c.execute("SELECT id FROM deals WHERE deal_hash=?", (deal_hash,))
    existing = c.fetchone()
    if existing:
        conn.close()
        return -existing['id']   # negative id signals "already existed"

    cols = ', '.join(deal.keys())
    phs  = ', '.join(['?'] * len(deal))
    c.execute(f"INSERT INTO deals ({cols}) VALUES ({phs})", list(deal.values()))
    deal_id = c.lastrowid
    conn.commit()
    conn.close()
    return deal_id


def get_deals(entity: str, metal: str, deal_date: str = None,
              from_date: str = None, to_date: str = None,
              limit: int = None) -> list:
    conn   = get_conn()
    c      = conn.cursor()
    params = [entity, metal]
    where  = "entity=? AND metal=?"

    if deal_date:
        where += " AND deal_date=?"
        params.append(deal_date)
    else:
        if from_date:
            where += " AND deal_date >= ?"
            params.append(from_date)
        if to_date:
            where += " AND deal_date <= ?"
            params.append(to_date)

    q = f"SELECT * FROM deals WHERE {where} ORDER BY deal_date ASC, id ASC"
    if limit:
        q += f" LIMIT {int(limit)}"
    c.execute(q, params)
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows


# ─────────────────────────────────────────────
# INVENTORY OPERATIONS
# ─────────────────────────────────────────────

def get_inventory(entity: str, metal: str) -> float:
    conn = get_conn()
    c    = conn.cursor()
    c.execute("SELECT total_oz FROM inventory WHERE entity=? AND metal=?", (entity, metal))
    row = c.fetchone()
    conn.close()
    return row['total_oz'] if row else 0.0


def update_inventory(entity: str, metal: str, delta_oz: float):
    conn = get_conn()
    c    = conn.cursor()
    c.execute("""
        INSERT INTO inventory (entity, metal, total_oz)
        VALUES (?, ?, ?)
        ON CONFLICT(entity, metal) DO UPDATE SET
            total_oz   = total_oz + excluded.total_oz,
            updated_at = datetime('now')
    """, (entity, metal, delta_oz))
    conn.commit()
    conn.close()


def set_inventory_position(entity: str, metal: str, oz: float):
    """
    Directly set the inventory to an absolute oz value.
    Use to enter the real ecosystem opening position (negative = short).
    """
    conn = get_conn()
    conn.execute("""
        INSERT INTO inventory (entity, metal, total_oz)
        VALUES (?, ?, ?)
        ON CONFLICT(entity, metal) DO UPDATE SET
            total_oz   = excluded.total_oz,
            updated_at = datetime('now')
    """, (entity, metal, oz))
    conn.commit()
    conn.close()


def get_aged_inventory(entity: str, metal: str) -> list:
    conn = get_conn()
    c    = conn.cursor()
    today = date.today().isoformat()
    c.execute("""
        SELECT *,
               CAST(julianday(?) - julianday(acquired_date) AS INTEGER) AS days_held
        FROM inventory_ageing
        WHERE entity=? AND metal=? AND disposed=0
        ORDER BY acquired_date ASC
    """, (today, entity, metal))
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows


# ─────────────────────────────────────────────
# CASH FLOW OPERATIONS
# ─────────────────────────────────────────────

def insert_cash_flow(flow: dict) -> int:
    conn = get_conn()
    c    = conn.cursor()
    cols = ', '.join(flow.keys())
    phs  = ', '.join(['?'] * len(flow))
    c.execute(f"INSERT INTO cash_flows ({cols}) VALUES ({phs})", list(flow.values()))
    flow_id = c.lastrowid
    conn.commit()
    conn.close()
    return flow_id


def get_cash_flows(entity: str, from_date: str = None, to_date: str = None) -> list:
    conn = get_conn()
    c    = conn.cursor()
    query = "SELECT * FROM cash_flows WHERE entity=?"
    params = [entity]
    if from_date:
        query += " AND flow_date >= ?"; params.append(from_date)
    if to_date:
        query += " AND flow_date <= ?"; params.append(to_date)
    query += " ORDER BY flow_date DESC"
    c.execute(query, params)
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows


# ─────────────────────────────────────────────
# SPOT PRICE OPERATIONS
# ─────────────────────────────────────────────

def get_hedging_positions(entity: str, metal: str) -> list:
    """Return all open hedging / other positions (Stone X, SAM, Proofs, etc.)."""
    conn = get_conn()
    c    = conn.cursor()
    c.execute("""
        SELECT * FROM hedging
        WHERE entity=? AND metal=? AND status='open'
        ORDER BY open_date DESC, id DESC
    """, (entity, metal))
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows


def insert_hedging_position(record: dict) -> int:
    conn = get_conn()
    c    = conn.cursor()
    cols = ', '.join(record.keys())
    phs  = ', '.join(['?'] * len(record))
    c.execute(f"INSERT INTO hedging ({cols}) VALUES ({phs})", list(record.values()))
    row_id = c.lastrowid
    conn.commit()
    conn.close()
    return row_id


def close_hedging_position(position_id: int):
    conn = get_conn()
    conn.execute("""
        UPDATE hedging SET status='closed', close_date=date('now') WHERE id=?
    """, (position_id,))
    conn.commit()
    conn.close()


def insert_spot_price(metal: str, price_zar: float, source: str = 'api'):
    conn = get_conn()
    conn.execute("INSERT INTO spot_prices (metal, price_zar, source) VALUES (?,?,?)",
                 (metal, price_zar, source))
    conn.commit()
    conn.close()


def get_latest_spot(metal: str) -> float:
    conn = get_conn()
    c    = conn.cursor()
    c.execute("SELECT price_zar FROM spot_prices WHERE metal=? ORDER BY recorded_at DESC LIMIT 1",
              (metal,))
    row = c.fetchone()
    conn.close()
    return row['price_zar'] if row else 0.0


# ─────────────────────────────────────────────
# DAILY SUMMARY OPERATIONS
# ─────────────────────────────────────────────

def upsert_daily_summary(summary: dict):
    conn = get_conn()
    c    = conn.cursor()
    c.execute("""
        INSERT INTO daily_summary (
            entity, metal, summary_date, deal_count,
            buy_oz, sell_oz, buy_value_zar, sell_value_zar,
            buy_vwap, sell_vwap, buy_margin_vwap, sell_margin_vwap,
            total_gp_zar, inventory_oz, spot_price_zar, inventory_value_zar,
            provision_active, provision_rate_pct
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(entity, metal, summary_date) DO UPDATE SET
            deal_count=excluded.deal_count,
            buy_oz=excluded.buy_oz, sell_oz=excluded.sell_oz,
            buy_value_zar=excluded.buy_value_zar, sell_value_zar=excluded.sell_value_zar,
            buy_vwap=excluded.buy_vwap, sell_vwap=excluded.sell_vwap,
            buy_margin_vwap=excluded.buy_margin_vwap,
            sell_margin_vwap=excluded.sell_margin_vwap,
            total_gp_zar=excluded.total_gp_zar,
            inventory_oz=excluded.inventory_oz,
            spot_price_zar=excluded.spot_price_zar,
            inventory_value_zar=excluded.inventory_value_zar,
            provision_active=excluded.provision_active,
            provision_rate_pct=excluded.provision_rate_pct
    """, (
        summary['entity'], summary['metal'], summary['date'], summary['deal_count'],
        summary['buy_oz'], summary['sell_oz'],
        summary['buy_value_zar'], summary['sell_value_zar'],
        summary['buy_vwap'], summary['sell_vwap'],
        summary['buy_margin_vwap'], summary['sell_margin_vwap'],
        summary['total_gp_zar'], summary['inventory_oz'],
        summary['spot_price_zar'], summary['inventory_value_zar'],
        1 if summary['provision_mode']['active'] else 0,
        summary['provision_mode']['rate_pct']
    ))
    conn.commit()
    conn.close()


if __name__ == '__main__':
    init_db()
