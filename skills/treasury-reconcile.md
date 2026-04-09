# treasury-reconcile

Daily cross-entity reconciliation: deals vs cash flows vs bank transactions.

## When to use
End of day, or when a bank statement has been uploaded and needs to be matched against deal records.

## Step 1 — Review today's cash flows

```python
from models import get_cash_flows
from datetime import date

today = date.today().isoformat()
for entity in ['SABIS', 'SABI', 'SABGB']:
    flows = get_cash_flows(entity, today, today)
    total_in  = sum(f['amount_zar'] for f in flows if f['direction'] == 'in')
    total_out = sum(f['amount_zar'] for f in flows if f['direction'] == 'out')
    print(f"{entity}: In R{total_in:,.0f} | Out R{total_out:,.0f} | Net R{total_in - total_out:,.0f}")
```

## Step 2 — Upload bank statement (via dashboard)

1. Go to [http://localhost:5000](http://localhost:5000)
2. Navigate to the Cash Flow & Reconciliation tab
3. Upload the CSV or Excel export from ABSA, FNB, Nedbank, or Standard Bank
4. The system auto-detects the bank format and maps columns

## Step 3 — Review unmatched items

```sql
-- Run in any SQLite client against data/treasury.db
SELECT bt.txn_date, bt.description, bt.amount_zar, bt.recon_status
FROM bank_transactions bt
WHERE bt.recon_status = 'unmatched'
ORDER BY bt.txn_date DESC;
```

## Step 4 — Manual match (if needed)

```python
import sqlite3
conn = sqlite3.connect('data/treasury.db')

# Get bank txn and cash flow IDs from the above query
bank_txn_id  = 42
cash_flow_id = 17

conn.execute("""
    INSERT INTO reconciliation (bank_txn_id, cash_flow_id, match_type, notes)
    VALUES (?, ?, 'manual', 'Matched by hand — dealer sheet #12')
""", (bank_txn_id, cash_flow_id))

conn.execute("UPDATE bank_transactions SET recon_status='matched', cash_flow_id=? WHERE id=?",
             (cash_flow_id, bank_txn_id))
conn.execute("UPDATE cash_flows SET reconciled=1 WHERE id=?", (cash_flow_id,))
conn.commit()
```

## Step 5 — Mark as ignored (timing differences, fees, etc.)

```sql
UPDATE bank_transactions SET recon_status='ignored' WHERE id=?;
```

## Supported bank statement formats

| Bank | Preferred export format |
|---|---|
| ABSA | CSV — History export |
| FNB | CSV — Account history |
| Nedbank | Excel (.xlsx) — Transaction history |
| Standard Bank | CSV — Account activity |

The importer auto-detects bank format by header structure. If a format isn't recognised, it lands in `data/errors/` with an `.error.txt` explanation.
