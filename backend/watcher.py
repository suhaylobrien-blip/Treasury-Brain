"""
Treasury Brain — Folder Watcher
Monitors the inbox folder for new dealer Excel files.
When a file lands, it is automatically processed.
"""

import time
import os
import json
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from importer import process_file
from models import get_deals, get_inventory, get_latest_spot
from processor import build_daily_summary
from models import upsert_daily_summary

CONFIG_PATH = os.path.join(os.path.dirname(__file__), '..', 'config', 'settings.json')
with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

INBOX = os.path.join(os.path.dirname(__file__), '..', CONFIG['inbox_folder'])
VALID_EXTENSIONS = {'.xlsx', '.xls', '.xlsm'}


class DealFileHandler(FileSystemEventHandler):
    """Handles new files dropped into the inbox folder."""

    def on_created(self, event):
        if event.is_directory:
            return
        filepath = event.src_path
        ext = os.path.splitext(filepath)[1].lower()
        if ext not in VALID_EXTENSIONS:
            print(f"[watcher] Ignored (not Excel): {filepath}")
            return

        # Small delay to ensure file is fully written before reading
        time.sleep(1.5)

        print(f"\n[watcher] New file detected: {os.path.basename(filepath)}")
        result = process_file(filepath)

        if result['status'] in ('success', 'partial'):
            _update_daily_summaries(result)

        print(f"[watcher] Done. Status: {result['status']}")

    def on_moved(self, event):
        """Also handle files moved into the inbox (e.g. from OneDrive sync)."""
        self.on_created(type('E', (), {'is_directory': False, 'src_path': event.dest_path})())


def _update_daily_summaries(import_result: dict):
    """After a successful import, refresh the daily summary for affected entity+metal combos."""
    from datetime import date

    today = date.today().isoformat()
    seen = set()

    for deal in import_result.get('deals', []):
        key = (deal['entity'], deal['metal'])
        if key in seen:
            continue
        seen.add(key)

        entity, metal = key
        deals_today = get_deals(entity, metal, today)
        inventory_oz = get_inventory(entity, metal)
        spot = get_latest_spot(metal)

        summary = build_daily_summary(entity, metal, deals_today, inventory_oz, spot)
        upsert_daily_summary(summary)
        print(f"[watcher] Daily summary updated: {entity} {metal}")


def start_watcher():
    """Start the folder watcher. Blocks until interrupted."""
    os.makedirs(INBOX, exist_ok=True)
    print(f"[watcher] Watching inbox: {os.path.abspath(INBOX)}")
    print("[watcher] Drop dealer Excel files here to auto-process. Ctrl+C to stop.\n")

    event_handler = DealFileHandler()
    observer = Observer()
    observer.schedule(event_handler, INBOX, recursive=False)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        print("\n[watcher] Stopped.")
    observer.join()


if __name__ == '__main__':
    start_watcher()
