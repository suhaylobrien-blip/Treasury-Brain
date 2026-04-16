"""
Treasury Brain — Database Layer (SQLite)
Single source of truth for all deal, inventory, hedging, cash flow and bank data.
"""

import hashlib
import sqlite3
import os
from datetime import date, datetime

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

    # ── INV PRODUCT MASTER ───────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS inv_products (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        sage_code      TEXT NOT NULL UNIQUE,
        product_name   TEXT NOT NULL,
        metal          TEXT NOT NULL CHECK(metal IN ('gold','silver')),
        category       TEXT NOT NULL CHECK(category IN ('bullion','proof')),
        uom_oz         REAL NOT NULL DEFAULT 1.0,
        display_order  INTEGER DEFAULT 999,
        active         INTEGER DEFAULT 1
    )""")

    # ── INV OPENING BALANCES ─────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS inv_opening_balance (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        entity       TEXT NOT NULL,
        sage_code    TEXT NOT NULL,
        balance_date TEXT NOT NULL DEFAULT (date('now')),
        eaches       REAL NOT NULL DEFAULT 0.0,
        notes        TEXT,
        created_at   TEXT DEFAULT (datetime('now')),
        UNIQUE(entity, sage_code, balance_date)
    )""")

    # ── INV PHYSICAL DATA (Abdellah's data) ──────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS inv_physical (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        entity                  TEXT NOT NULL,
        sage_code               TEXT NOT NULL,
        record_date             TEXT NOT NULL DEFAULT (date('now')),
        outstanding_collections REAL DEFAULT 0.0,
        custody_storage_ledger  REAL DEFAULT 0.0,
        awaiting_delivery       REAL DEFAULT 0.0,
        expected_physical       REAL DEFAULT 0.0,
        notes                   TEXT,
        updated_at              TEXT DEFAULT (datetime('now')),
        UNIQUE(entity, sage_code, record_date)
    )""")

    # ── INV SAGE RECON ───────────────────────────────────────────────────
    c.execute("""
    CREATE TABLE IF NOT EXISTS inv_sage_recon (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity      TEXT NOT NULL,
        sage_code   TEXT NOT NULL,
        record_date TEXT NOT NULL DEFAULT (date('now')),
        sage_eaches REAL DEFAULT 0.0,
        notes       TEXT,
        updated_at  TEXT DEFAULT (datetime('now')),
        UNIQUE(entity, sage_code, record_date)
    )""")

    conn.commit()
    seed_inv_products(conn)
    seed_inv_test_data(conn)
    seed_inv_test_physical(conn)
    seed_inv_test_sage(conn)
    seed_inv_proof_data(conn)
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
    conn.execute("PRAGMA foreign_keys = OFF")
    c    = conn.cursor()
    c.execute("DELETE FROM cash_flows       WHERE entity=?",             (entity,))
    c.execute("DELETE FROM inventory_ageing WHERE entity=? AND metal=?", (entity, metal))
    c.execute("DELETE FROM deals            WHERE entity=? AND metal=?", (entity, metal))
    c.execute("DELETE FROM pipeline         WHERE entity=? AND metal=?", (entity, metal))
    c.execute("DELETE FROM inventory        WHERE entity=? AND metal=?", (entity, metal))
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
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

def get_hedging_positions(entity: str, metal: str,
                           from_date: str = None, to_date: str = None) -> list:
    """Return open hedging positions (Stone X, SAM, Proofs, etc.), with optional date range."""
    conn   = get_conn()
    c      = conn.cursor()
    where  = "entity=? AND metal=? AND status='open'"
    params = [entity, metal]
    if from_date:
        where += " AND open_date >= ?"
        params.append(from_date)
    if to_date:
        where += " AND open_date <= ?"
        params.append(to_date)
    c.execute(f"SELECT * FROM hedging WHERE {where} ORDER BY open_date DESC, id DESC", params)
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


def close_hedging_position(position_id: int, close_price_zar: float = None) -> float:
    """
    Close a hedge position. If close_price_zar is supplied, compute and store pnl_zar.
    Long PNL  = (close - open) * oz
    Short PNL = (open  - close) * oz
    Returns the realized PNL (or 0 if no close price given).
    """
    conn = get_conn()
    c    = conn.cursor()
    row  = c.execute(
        "SELECT position_type, contract_oz, open_price_zar FROM hedging WHERE id=?",
        (position_id,)
    ).fetchone()
    pnl = None
    if row and close_price_zar:
        pos_type, oz, open_price = row['position_type'], row['contract_oz'], row['open_price_zar']
        pnl = (close_price_zar - open_price) * oz if pos_type == 'long' \
              else (open_price - close_price_zar) * oz
    conn.execute("""
        UPDATE hedging
        SET status='closed', close_date=date('now'),
            close_price_zar = COALESCE(?, close_price_zar),
            pnl_zar         = COALESCE(?, pnl_zar)
        WHERE id=?
    """, (close_price_zar, pnl, position_id))
    conn.commit()
    conn.close()
    return pnl or 0.0


def get_realized_hedge_pnl(entity: str, metal: str,
                            from_date: str = None, to_date: str = None) -> dict:
    """
    Return realized PNL from formally closed hedge positions.
    Uses stored pnl_zar if available; recomputes from prices if not.
    """
    conn   = get_conn()
    c      = conn.cursor()
    where  = "entity=? AND metal=? AND status='closed'"
    params = [entity, metal]
    if from_date:
        where += " AND close_date>=?"
        params.append(from_date)
    if to_date:
        where += " AND close_date<=?"
        params.append(to_date)
    rows = c.execute(
        f"SELECT position_type, contract_oz, open_price_zar, close_price_zar, pnl_zar "
        f"FROM hedging WHERE {where} ORDER BY close_date DESC",
        params
    ).fetchall()
    conn.close()

    total = 0.0
    positions = []
    for row in rows:
        pos_type, oz, open_p, close_p, stored_pnl = (
            row['position_type'], row['contract_oz'],
            row['open_price_zar'], row['close_price_zar'], row['pnl_zar']
        )
        if stored_pnl is not None:
            pnl = stored_pnl
        elif close_p is not None:
            pnl = (close_p - open_p) * oz if pos_type == 'long' else (open_p - close_p) * oz
        else:
            pnl = 0.0
        total += pnl
        positions.append({
            'position_type': pos_type, 'contract_oz': oz,
            'open_price_zar': open_p, 'close_price_zar': close_p, 'pnl_zar': round(pnl, 2)
        })
    return {'realized_pnl': round(total, 2), 'count': len(positions), 'positions': positions}


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


def get_spot_age_seconds(metal: str) -> float:
    """Returns seconds since the last spot price was recorded. Returns inf if none."""
    conn = get_conn()
    c    = conn.cursor()
    c.execute("SELECT recorded_at FROM spot_prices WHERE metal=? ORDER BY recorded_at DESC LIMIT 1",
              (metal,))
    row = c.fetchone()
    conn.close()
    if not row:
        return float('inf')
    try:
        recorded = datetime.strptime(row['recorded_at'], '%Y-%m-%d %H:%M:%S')
        return (datetime.utcnow() - recorded).total_seconds()
    except Exception:
        return float('inf')


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


# ─────────────────────────────────────────────
# INVENTORY SEED DATA
# ─────────────────────────────────────────────

def seed_inv_products(conn):
    """Seed the inv_products table. Safe to run multiple times via INSERT OR IGNORE."""
    c = conn.cursor()

    # Gold Bullion
    gold_bullion = [
        ('100 Corona',   '100 Corona - Franz Joseph I',               1.000, 10),
        ('1GCM2025',     '1g MapleGram Gold 2025',                     0.032, 20),
        ('1ozUBU',       'Gold Ubuntu 1oz Coin',                       1.000, 30),
        ('2GDin',        '0.25oz Gold Dinar',                          0.250, 40),
        ('2PKR',         '2oz Proof Krugerrand',                       2.000, 50),
        ('BPond',        'Gold Proof Burgersspond 4 Medallion SET',    1.000, 60),
        ('CGP2',         'South Africa 1/2 Pound Gold Coin',           0.500, 70),
        ('Damage',       'Damage KR Coin',                             1.000, 80),
        ('FIF',          'R1 1/10oz AU999.9',                          0.100, 90),
        ('GCAE1',        '1oz Gold American Eagle',                    1.000, 100),
        ('GCAR1',        '1oz Gold Austrian Philharmonic',             1.000, 110),
        ('GCB',          '1oz Gold Britannia',                         1.000, 120),
        ('GCMPL',        '1oz Gold Canadian Maple Leaf',               1.000, 130),
        ('GCMPL10',      '1/10oz Canadian Gold Maple Leaf',            0.100, 140),
        ('GCMR200',      'R200 Mandela 20yr of Democracy',             1.000, 150),
        ('GCNat1',       'The Natura Gold Coin 1oz',                   1.000, 160),
        ('GCNat10',      'The Natura Gold Coin 1/10oz',                0.100, 170),
        ('GCNat20',      'The Natura Gold Coin 1/20oz',                0.050, 180),
        ('GCNat4',       'The Natura Gold Coin 1/4oz',                 0.250, 190),
        ('GCP1',         '1 Pond Zuid Afrikaansche Republiek',         1.000, 200),
        ('GCPro1',       'Gold Protea Coin 1oz',                       1.000, 210),
        ('GCPro10',      'Gold Protea Coin 1/10oz',                    0.100, 220),
        ('GCPro2',       'Gold Protea Coin 1/2oz',                     0.500, 230),
        ('GCPro4',       'Gold Protea Coin 1/4oz',                     0.250, 240),
        ('GCSAR1',       'SA 1 Rand Gold Coin',                        0.250, 250),
        ('GCSAR2',       'SA 2 Rand Gold Coin',                        1.000, 260),
        ('GDin',         'Gold Dinar',                                 0.250, 270),
        ('GDin852',      'Gold Dinar 8.52g',                           0.161, 280),
        ('GDPro',        'Gold Dias Protea Coin',                      1.000, 290),
        ('GGRob',        'Robben Island Gold Coin',                    1.000, 300),
        ('GHPro',        'Gold Huguenot Protea Coin',                  1.000, 310),
        ('GJPro',        'Gold Johannesburg Protea Coin',              1.000, 320),
        ('GM12oz',       '15.55g PAMP Minted Bar',                     0.500, 330),
        ('GM10MetCon',   '10g Minted Bar (MetCon)',                    0.322, 340),
        ('GM10RRL',      '10g Minted Bar (RRL)',                       0.322, 350),
        ('GM100',        '100g Minted Gold Bar',                       3.215, 360),
        ('GM50',         '50g Minted Gold Bar',                        1.608, 370),
        ('GMR5A',        'Gold Medallion 20th Anniversary',            1.000, 380),
        ('GP2',          '1/2oz Gold Coin',                            0.500, 390),
        ('GSV4',         '4g Gold Sovereign',                          1.000, 400),
        ('GSV8',         '8g Gold Sovereign',                          1.000, 410),
        ('GTPro',        'Gold Trek Protea Coin',                      1.000, 420),
        ('KR1',          '1oz Krugerrand',                             1.000, 1),
        ('KR10',         '1/10oz Krugerrand',                          0.100, 3),
        ('KR20',         '1/20oz Krugerrand',                          0.050, 4),
        ('KR4',          '1/4oz Krugerrand',                           0.250, 2),
        ('KR50',         '1/50oz Krugerrand',                          0.020, 5),
        ('KRSet',        'Full KR Set',                                1.930, 6),
        ('LI1',          '2019 Big 5 Lion 1oz Gold AU 999',            1.000, 430),
        ('ManC2',        'Mandela 1/2oz Gold Coin',                    0.500, 440),
        ('MandelaR2',    'Mandela R2 Gold Coin',                       1.000, 450),
        ('NGCSCnat',     'Natura Gold Centenary Set',                  1.000, 460),
        ('RIAL',         '50 Rial',                                    1.000, 470),
        ('SA1985',       '1985 Parliament Gold Coin',                  1.000, 480),
        ('SCBrit1',      '1oz Gold Britannia (SCBrit1)',                1.000, 490),
        ('VGC',          'Vreneli Gold Coin',                          1.000, 500),
        ('ADHOK_AU',     'ADHOK Gold Coin',                            1.000, 510),
    ]
    for sage_code, product_name, uom_oz, display_order in gold_bullion:
        c.execute("""
            INSERT OR IGNORE INTO inv_products (sage_code, product_name, metal, category, uom_oz, display_order)
            VALUES (?, ?, 'gold', 'bullion', ?, ?)
        """, (sage_code, product_name, uom_oz, display_order))

    # Silver Bullion
    silver_bullion = [
        ('AGGCPro1',   'Silver Protea Coin 1oz',                         1.00,  10),
        ('ASNA',       'Armenian Silver Noahs Ark',                      1.00,  20),
        ('Aztec10oz',  '10oz Aztec Calendar Silver Bar',                 10.00, 30),
        ('Aztec1oz',   '1oz Silver Bar Aztec Calendar',                  1.00,  40),
        ('JM1',        '1oz Silver Johnson Matthey Minted Bar',          1.00,  50),
        ('SABIS1KG',   'SA Bullion 1kg Silver Bar',                      32.15, 60),
        ('SAC',        '1oz Silver Aztec Calender',                      1.00,  70),
        ('SB1000',     '1kg Silver Bar',                                 32.15, 80),
        ('SB500',      '500g Silver Bar',                                16.08, 90),
        ('SCAE1',      '1oz Silver Bullion American Eagle',              1.00,  100),
        ('SCAPhil',    'Austrian Silver Philharmonic',                   1.00,  1),
        ('SCBrit',     '1oz Silver Britannia Coin',                      1.00,  2),
        ('SCBrit025',  '2025 1/4oz Silver Britannia',                    0.25,  110),
        ('SCCML1',     '1oz Silver Bullion Canadian Maple Leaves',       1.00,  3),
        ('SCCMPL100',  '100oz Canadian Maple Leave Bar',                 100.00,120),
        ('SHIC',       'Silver Indian Head Coins',                       1.00,  130),
        ('SHT',        '1oz Silver Hawksbill Turtle',                    1.00,  140),
        ('SK1KG',      '1kg Pure Silver Coin',                           32.15, 150),
        ('SK1',        '1oz Australian Silver Koala',                    1.00,  160),
        ('SK1KGA',     '1kg Australian Silver Koala',                    32.15, 170),
        ('SKA',        '1oz Australian Silver Kangaroo',                 1.00,  4),
        ('SKB1KG',     '1kg Australian Silver Kookaburra',               32.15, 180),
        ('SKK',        '1oz Australian Silver Kookaburra',               1.00,  5),
        ('SKR1',       '1oz Silver Krugerrand',                          1.00,  6),
        ('SKR500',     'Silver Monsterbox 500oz',                        500.00,190),
        ('SM1',        '1oz Silver Minted Bar (RRL)',                    1.00,  200),
        ('SM100',      '100g Silver Minted Bar',                         3.22,  210),
        ('SMC1',       '1oz Silver Minted Bar (MetCon)',                 1.00,  220),
        ('SU1OZCT',    '1oz Silver Ubuntu Coin',                         1.00,  230),
        ('SWSM1',      'Star Wars Jedi 1oz Silver Minted Bar',           1.00,  240),
        ('SWSM10',     'Star Wars Sith 10oz Silver Minted Bar',          10.00, 250),
        ('SWSM1oz',    'Star Wars Sith 1oz Silver Minted Bar',           1.00,  260),
        ('ADHOK_AG',   'ADHOK Silver Coins',                             1.00,  270),
        ('SCBritLib',  'Britannia Liberty',                              1.00,  280),
        ('SB15000',    '15kg Silver Bullion Cast Bar',                   482.25,290),
        ('SCBrit010',  '1/10oz Silver Britannia Coin',                   0.10,  300),
        ('SCMexLib1',  '1oz Silver Mexican Libertad',                    1.00,  310),
    ]
    for sage_code, product_name, uom_oz, display_order in silver_bullion:
        c.execute("""
            INSERT OR IGNORE INTO inv_products (sage_code, product_name, metal, category, uom_oz, display_order)
            VALUES (?, ?, 'silver', 'bullion', ?, ?)
        """, (sage_code, product_name, uom_oz, display_order))

    # Gold Proof
    gold_proof = [
        ('PKR1',  '1oz Proof Krugerrand',   1.000, 1),
        ('PKR10', '1/10oz Proof Krugerrand',0.100, 2),
        ('PKR2',  '1/2oz Proof Krugerrand', 0.500, 3),
        ('PKR4',  '1/4oz Proof Krugerrand', 0.250, 4),
    ]
    for sage_code, product_name, uom_oz, display_order in gold_proof:
        c.execute("""
            INSERT OR IGNORE INTO inv_products (sage_code, product_name, metal, category, uom_oz, display_order)
            VALUES (?, ?, 'gold', 'proof', ?, ?)
        """, (sage_code, product_name, uom_oz, display_order))

    # Silver Proof
    silver_proof = [
        ('YOTD05',       '2024 Year of the Dragon 1/2oz Silver Bullion Coloured Coin', 0.50, 10),
        ('YOTS05B',      '2025 Year of the Snake 1/2oz Silver Bullion Coin',           0.50, 20),
        ('YOTS05P',      '2025 Year of the Snake 1/2oz Silver Proof Coin',             0.50, 30),
        ('YOTD1',        '2024 Year of the Dragon 1oz Silver Bullion Coloured Coin',   1.00, 40),
        ('YOTS1B',       '2025 Year of the Snake 1oz Silver Bullion Coin',             1.00, 50),
        ('YOTS1P',       '2025 Year of the Snake 1oz Silver Proof Coin',               1.00, 60),
        ('AusCroc',      '2oz Australia Crocodile',                                    2.00, 70),
        ('AusKoa',       '2oz Australia Koala',                                        2.00, 80),
        ('RedDragon',    '2oz Red Dragon of Wales',                                    2.00, 90),
        ('YOTD2',        '2024 Year of the Dragon 2oz Silver Bullion Coloured Coin',   2.00, 100),
        ('Shilling5',    'Proof Silver 5 Shillings',                                   0.10, 110),
        ('AGGCPro1_P',   'Silver Protea Coin 1oz (Proof)',                             1.00, 120),
        ('RH1',          '2022 Big 5 Rhino 1oz Silver Ag 999',                         1.00, 130),
        ('RSA724',       'RSA Proof 7 Coin Set W Crown 1oz 2024',                      1.00, 140),
        ('SILPCB5523',   'Silver Big 5 Coin Set 2023',                                 1.00, 150),
        ('SILPCKR1JHB',  '2024 1oz Silver Johannesburg Fair Privy Mark Proof KR',      1.00, 160),
        ('SILPCKRBU223', 'Big 5 Buffalo 2 Coin Set',                                   1.00, 170),
        ('SPC',          'Proof Silver Crown - 925 Sterling Silver',                   1.00, 180),
        ('SU1OZCT_P',    'Silver Ubuntu 1oz Coin (Proof)',                             1.00, 190),
        ('UK24HPSP',     'Harry Potter Winged Keys 2024 UK 50p Colour Silver Proof Coin', 1.00, 200),
        ('UK26FCSP',     'Harry Potter The Flying Car 2025 UK 50p Coloured Silver Proof Coin', 1.00, 210),
    ]
    for sage_code, product_name, uom_oz, display_order in silver_proof:
        c.execute("""
            INSERT OR IGNORE INTO inv_products (sage_code, product_name, metal, category, uom_oz, display_order)
            VALUES (?, ?, 'silver', 'proof', ?, ?)
        """, (sage_code, product_name, uom_oz, display_order))

    conn.commit()


def seed_inv_test_data(conn):
    """Seed test opening balances. Safe to run multiple times via INSERT OR IGNORE."""
    c = conn.cursor()
    entity = 'SABIS'
    bal_date = '2026-01-01'

    test_balances = [
        # Gold Bullion
        ('KR1',   500),
        ('KR4',   200),
        ('KR10',  400),
        ('KR20',  100),
        ('GCB',    50),
        ('GCAE1',  30),
        ('GCAR1',  80),
        ('GM100',  15),
        ('GM50',   25),
        # Silver Bullion
        ('SKR1',  1200),
        ('SCAPhil', 300),
        ('SCBrit',  400),
        ('SKA',     150),
        ('SKK',     200),
        ('SCCML1',  350),
        ('SM1',     500),
        ('SB1000',   20),
        ('SB500',    30),
        # Gold Proof
        ('PKR1',  25),
        ('PKR2',  15),
        ('PKR4',  20),
        ('PKR10', 30),
        # Silver Proof
        ('YOTD1',  50),
        ('YOTS1B', 40),
        ('AusCroc',20),
        ('RH1',    35),
    ]
    for sage_code, eaches in test_balances:
        c.execute("""
            INSERT OR IGNORE INTO inv_opening_balance (entity, sage_code, balance_date, eaches)
            VALUES (?, ?, ?, ?)
        """, (entity, sage_code, bal_date, eaches))
    conn.commit()


def seed_inv_test_physical(conn):
    """Seed test physical data. Safe to run multiple times via INSERT OR IGNORE."""
    c = conn.cursor()
    entity = 'SABIS'
    rec_date = '2026-04-15'

    test_physical = [
        # Gold Bullion
        ('KR1',  20, 30, 5,  10),
        ('KR4',  10, 15, 2,   5),
        ('KR10', 25, 40, 10, 15),
        ('GCB',   5,  8,  0,  3),
        ('GCAE1', 3,  5,  0,  2),
        # Silver Bullion
        ('SKR1',   80, 120, 20, 40),
        ('SCAPhil',30,  50, 10, 20),
        ('SCBrit', 40,  60, 15, 25),
    ]
    for sage_code, os_col, cust, await_del, exp_phys in test_physical:
        c.execute("""
            INSERT OR IGNORE INTO inv_physical
              (entity, sage_code, record_date, outstanding_collections,
               custody_storage_ledger, awaiting_delivery, expected_physical)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (entity, sage_code, rec_date, os_col, cust, await_del, exp_phys))
    conn.commit()


def seed_inv_test_sage(conn):
    """Seed test Sage recon data. Safe to run multiple times via INSERT OR IGNORE."""
    c = conn.cursor()
    entity = 'SABIS'
    rec_date = '2026-04-15'

    test_sage = [
        # Gold Bullion (KR1 has deliberate 2-unit discrepancy)
        ('KR1',   498),
        ('KR4',   200),
        ('KR10',  400),
        ('KR20',  100),
        ('GCB',    50),
        ('GCAE1',  30),
        # Silver Bullion (SCBrit has 1-unit discrepancy)
        ('SKR1',  1200),
        ('SCAPhil', 300),
        ('SCBrit',  399),
        ('SKA',     150),
    ]
    for sage_code, sage_eaches in test_sage:
        c.execute("""
            INSERT OR IGNORE INTO inv_sage_recon (entity, sage_code, record_date, sage_eaches)
            VALUES (?, ?, ?, ?)
        """, (entity, sage_code, rec_date, sage_eaches))
    conn.commit()


# ─────────────────────────────────────────────
# PROOF INVENTORY SEED DATA
# ─────────────────────────────────────────────

def seed_inv_proof_data(conn):
    """
    Seed complete opening balances, physical data, and Sage recon data
    for ALL proof products (gold + silver). Safe to run multiple times
    via INSERT OR IGNORE — will not overwrite existing entries.
    """
    c = conn.cursor()
    entity   = 'SABIS'
    bal_date = '2026-01-01'
    rec_date = '2026-04-15'

    # ── Opening balances ─────────────────────────────────────────────
    # Gold Proof — all 4 proof Krugerrand sizes
    gold_proof_balances = [
        ('PKR1',  25),   # 1oz Proof KR
        ('PKR2',  15),   # 1/2oz Proof KR
        ('PKR4',  20),   # 1/4oz Proof KR
        ('PKR10', 30),   # 1/10oz Proof KR
    ]
    # Silver Proof — all 21 products
    silver_proof_balances = [
        ('YOTD05',        10),   # 2024 Dragon 1/2oz
        ('YOTS05B',       15),   # 2025 Snake 1/2oz Bullion
        ('YOTS05P',        8),   # 2025 Snake 1/2oz Proof
        ('YOTD1',         50),   # 2024 Dragon 1oz
        ('YOTS1B',        40),   # 2025 Snake 1oz Bullion
        ('YOTS1P',        25),   # 2025 Snake 1oz Proof
        ('AusCroc',       20),   # 2oz Australia Crocodile
        ('AusKoa',        12),   # 2oz Australia Koala
        ('RedDragon',     15),   # 2oz Red Dragon of Wales
        ('YOTD2',         10),   # 2024 Dragon 2oz
        ('Shilling5',     30),   # Proof Silver 5 Shillings
        ('AGGCPro1_P',    18),   # Silver Protea 1oz Proof
        ('RH1',           35),   # 2022 Big 5 Rhino 1oz
        ('RSA724',         8),   # RSA Proof 7 Coin Set 2024
        ('SILPCB5523',    12),   # Silver Big 5 Coin Set 2023
        ('SILPCKR1JHB',    6),   # JHB Fair Privy Mark Proof KR
        ('SILPCKRBU223',  10),   # Big 5 Buffalo 2 Coin Set
        ('SPC',            5),   # Proof Silver Crown 925
        ('SU1OZCT_P',     20),   # Silver Ubuntu 1oz Proof
        ('UK24HPSP',       8),   # Harry Potter Winged Keys
        ('UK26FCSP',       6),   # Harry Potter Flying Car
    ]

    for sage_code, eaches in gold_proof_balances + silver_proof_balances:
        c.execute("""
            INSERT OR IGNORE INTO inv_opening_balance (entity, sage_code, balance_date, eaches)
            VALUES (?, ?, ?, ?)
        """, (entity, sage_code, bal_date, eaches))

    # ── Physical data (outstanding collections, custody, awaiting, expected) ──
    # Gold Proof
    gold_proof_physical = [
        # sage_code, os_collections, custody_ledger, awaiting_delivery, expected_physical
        ('PKR1',   5,  8, 2, 3),
        ('PKR2',   3,  4, 1, 2),
        ('PKR4',   4,  5, 1, 2),
        ('PKR10',  6,  8, 2, 4),
    ]
    # Silver Proof (key products)
    silver_proof_physical = [
        ('YOTD1',   10, 12, 3, 5),
        ('YOTS1B',   8, 10, 2, 4),
        ('YOTS1P',   5,  6, 1, 2),
        ('AusCroc',  4,  5, 1, 2),
        ('AusKoa',   3,  4, 1, 1),
        ('RedDragon',4,  5, 1, 2),
        ('RH1',      6,  8, 2, 3),
        ('RSA724',   2,  3, 0, 1),
        ('YOTD05',   3,  4, 1, 2),
        ('YOTS05B',  4,  5, 1, 2),
        ('AGGCPro1_P',3, 4, 1, 2),
        ('SU1OZCT_P',5,  6, 1, 2),
    ]

    for sage_code, os_col, cust, await_del, exp_phys in gold_proof_physical + silver_proof_physical:
        c.execute("""
            INSERT OR IGNORE INTO inv_physical
              (entity, sage_code, record_date, outstanding_collections,
               custody_storage_ledger, awaiting_delivery, expected_physical)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (entity, sage_code, rec_date, os_col, cust, await_del, exp_phys))

    # ── Sage recon data (mostly matching, one deliberate mismatch per category) ──
    # Gold Proof — PKR2 has 1-unit discrepancy for demo
    gold_proof_sage = [
        ('PKR1',  25),   # match
        ('PKR2',  14),   # MISMATCH (15 vs 14)
        ('PKR4',  20),   # match
        ('PKR10', 30),   # match
    ]
    # Silver Proof — AusCroc has 1-unit discrepancy for demo
    silver_proof_sage = [
        ('YOTD1',   50),  # match
        ('YOTS1B',  40),  # match
        ('YOTS1P',  25),  # match
        ('AusCroc', 19),  # MISMATCH (20 vs 19)
        ('AusKoa',  12),  # match
        ('RedDragon',15), # match
        ('RH1',     35),  # match
        ('RSA724',   8),  # match
        ('YOTD05',  10),  # match
        ('YOTS05B', 15),  # match
        ('AGGCPro1_P',18),# match
        ('SU1OZCT_P',20), # match
    ]

    for sage_code, sage_eaches in gold_proof_sage + silver_proof_sage:
        c.execute("""
            INSERT OR IGNORE INTO inv_sage_recon (entity, sage_code, record_date, sage_eaches)
            VALUES (?, ?, ?, ?)
        """, (entity, sage_code, rec_date, sage_eaches))

    conn.commit()


# ─────────────────────────────────────────────
# INVENTORY SNAPSHOT
# ─────────────────────────────────────────────

def get_inv_snapshot(entity, metal, category, date_str=None):
    """
    Build a full inventory snapshot for entity/metal/category up to date_str.
    Returns: { products: [...], items: { sage_code: {...} }, ecosystem: {...} }
    """
    if not date_str:
        date_str = date.today().isoformat()

    conn = get_conn()
    c = conn.cursor()

    # 1. Get all active products for this metal+category
    products = [dict(r) for r in c.execute("""
        SELECT * FROM inv_products
        WHERE metal=? AND category=? AND active=1
        ORDER BY display_order, product_name
    """, (metal, category)).fetchall()]

    items = {}

    for p in products:
        sage_code = p['sage_code']
        uom_oz    = p['uom_oz']

        # 2. Opening balance (latest row with balance_date <= date_str)
        ob_row = c.execute("""
            SELECT eaches FROM inv_opening_balance
            WHERE entity=? AND sage_code=? AND balance_date <= ?
            ORDER BY balance_date DESC LIMIT 1
        """, (entity, sage_code, date_str)).fetchone()
        opening_eaches = dict(ob_row)['eaches'] if ob_row else 0.0

        # 3. Deal adjustments (buys and sells from deals table)
        buy_row = c.execute("""
            SELECT COALESCE(SUM(units), 0) AS total
            FROM deals
            WHERE entity=? AND metal=? AND product_code=? AND deal_type='buy' AND deal_date <= ?
        """, (entity, metal, sage_code, date_str)).fetchone()
        buy_units = dict(buy_row)['total'] if buy_row else 0.0

        sell_row = c.execute("""
            SELECT COALESCE(SUM(units), 0) AS total
            FROM deals
            WHERE entity=? AND metal=? AND product_code=? AND deal_type='sell' AND deal_date <= ?
        """, (entity, metal, sage_code, date_str)).fetchone()
        sell_units = dict(sell_row)['total'] if sell_row else 0.0

        closing_eaches = opening_eaches + buy_units - sell_units
        closing_oz     = closing_eaches * uom_oz

        # 4. Physical data (latest record_date <= date_str)
        phys_row = c.execute("""
            SELECT outstanding_collections, custody_storage_ledger,
                   awaiting_delivery, expected_physical
            FROM inv_physical
            WHERE entity=? AND sage_code=? AND record_date <= ?
            ORDER BY record_date DESC LIMIT 1
        """, (entity, sage_code, date_str)).fetchone()
        phys = dict(phys_row) if phys_row else {
            'outstanding_collections': 0.0,
            'custody_storage_ledger':  0.0,
            'awaiting_delivery':       0.0,
            'expected_physical':       0.0,
        }

        # 5. Sage data (latest record_date <= date_str)
        sage_row = c.execute("""
            SELECT sage_eaches FROM inv_sage_recon
            WHERE entity=? AND sage_code=? AND record_date <= ?
            ORDER BY record_date DESC LIMIT 1
        """, (entity, sage_code, date_str)).fetchone()
        sage_eaches = dict(sage_row)['sage_eaches'] if sage_row else None

        # Computed fields
        total_physical_req = phys['outstanding_collections'] + phys['custody_storage_ledger']
        threshold_stock    = closing_eaches * 0.40
        available_to_sell  = closing_eaches - threshold_stock
        if sage_eaches is not None:
            recon_match = abs(closing_eaches - sage_eaches) < 0.01
        else:
            recon_match = None

        items[sage_code] = {
            'product_name':             p['product_name'],
            'uom_oz':                   uom_oz,
            'opening_eaches':           opening_eaches,
            'buy_units':                buy_units,
            'sell_units':               sell_units,
            'closing_eaches':           closing_eaches,
            'closing_oz':               closing_oz,
            'outstanding_collections':  phys['outstanding_collections'],
            'custody_storage_ledger':   phys['custody_storage_ledger'],
            'awaiting_delivery':        phys['awaiting_delivery'],
            'expected_physical':        phys['expected_physical'],
            'total_physical_req':       total_physical_req,
            'sage_eaches':              sage_eaches,
            'threshold_stock':          threshold_stock,
            'available_to_sell':        available_to_sell,
            'recon_match':              recon_match,
        }

    # 6. Hedge totals from hedging table
    # SAM platform
    sam_rows = c.execute("""
        SELECT position_type, COALESCE(SUM(contract_oz), 0) AS total_oz
        FROM hedging
        WHERE entity=? AND metal=? AND status='open' AND platform='SAM'
        GROUP BY position_type
    """, (entity, metal)).fetchall()
    sam_long_oz  = 0.0
    sam_short_oz = 0.0
    for row in sam_rows:
        r = dict(row)
        if r['position_type'] == 'long':
            sam_long_oz  = r['total_oz']
        else:
            sam_short_oz = r['total_oz']
    sam_hedged_oz = sam_long_oz - sam_short_oz

    # SX (Stone X) platform
    sx_rows = c.execute("""
        SELECT position_type, COALESCE(SUM(contract_oz), 0) AS total_oz
        FROM hedging
        WHERE entity=? AND metal=? AND status='open'
          AND (platform LIKE '%Stone%' OR platform LIKE '%SX%' OR platform='Stone X')
        GROUP BY position_type
    """, (entity, metal)).fetchall()
    sx_long_oz  = 0.0
    sx_short_oz = 0.0
    for row in sx_rows:
        r = dict(row)
        if r['position_type'] == 'long':
            sx_long_oz  = r['total_oz']
        else:
            sx_short_oz = r['total_oz']
    sx_hedged_oz = sx_long_oz - sx_short_oz

    conn.close()

    # 7. Ecosystem totals
    total_inv_oz        = sum(it['closing_oz'] for it in items.values())
    total_synthetic_oz  = sam_hedged_oz + sx_hedged_oz
    ecosystem_oz        = total_inv_oz + total_synthetic_oz

    return {
        'products':  products,
        'items':     items,
        'ecosystem': {
            'total_inv_oz':        total_inv_oz,
            'sam_hedged_oz':       sam_hedged_oz,
            'sx_hedged_oz':        sx_hedged_oz,
            'total_synthetic_oz':  total_synthetic_oz,
            'ecosystem_oz':        ecosystem_oz,
        },
    }


if __name__ == '__main__':
    init_db()
