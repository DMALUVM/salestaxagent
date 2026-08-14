from __future__ import annotations

import shutil
import time
from datetime import datetime
from pathlib import Path

from watchdog.events import FileSystemEventHandler, FileCreatedEvent
from watchdog.observers import Observer

from src.config import settings
from src.parsers.amazon_inventory import ingest_amazon_inventory
from src.parsers.shopify_orders import ingest_shopify_csv


class IncomingFileHandler(FileSystemEventHandler):
    def __init__(self, print_fn=print):
        self.print_fn = print_fn

    def on_created(self, event: FileCreatedEvent):
        if event.is_directory:
            return

        path = Path(event.src_path)
        if path.name.startswith(".") or path.name.startswith("~"):
            return

        suffix = path.suffix.lower()

        parent = path.parent.name.lower()

        if parent == "rulings":
            if suffix not in (".json", ".pdf", ".html", ".htm", ".txt"):
                return
        elif suffix not in (".csv", ".txt", ".tsv"):
            return

        time.sleep(1)

        try:
            if parent == "amazon":
                self.print_fn(f"[Watcher] Processing Amazon file: {path.name}")
                result = ingest_amazon_inventory(path)
                self.print_fn(f"[Watcher] Amazon ingestion complete: {result.get('rows_inserted', 0)} rows inserted, "
                              f"states: {result.get('states_found', [])}")
                if result.get("warnings"):
                    for w in result["warnings"]:
                        self.print_fn(f"[Watcher] Warning: {w}")
            elif parent == "shopify":
                self.print_fn(f"[Watcher] Processing Shopify file: {path.name}")
                result = ingest_shopify_csv(path)
                self.print_fn(f"[Watcher] Shopify ingestion complete: {result.get('rows_inserted', 0)} rows inserted, "
                              f"states: {result.get('states_found', [])}")
            elif parent == "rulings":
                self._process_ruling(path, suffix)
            else:
                self.print_fn(f"[Watcher] Unknown folder '{parent}' for file {path.name}. "
                              f"Place in incoming/amazon/, incoming/shopify/, or incoming/rulings/")
                return

            self._archive(path, parent)

        except Exception as e:
            self.print_fn(f"[Watcher] Error processing {path.name}: {e}")

    def _process_ruling(self, path: Path, suffix: str):
        if suffix == ".json":
            self.print_fn(f"[Watcher] Processing ruling file: {path.name}")
            from src.intelligence.rulings import ingest_ruling_file
            result = ingest_ruling_file(path)
            self.print_fn(f"[Watcher] Ruling ingestion: {result.get('court_rulings_added', 0)} court, "
                          f"{result.get('admin_rulings_added', 0)} admin rulings added")
            if result.get("errors"):
                for e in result["errors"]:
                    self.print_fn(f"[Watcher] Ruling error: {e}")
        else:
            self.print_fn(f"[Watcher] Registering raw document for extraction: {path.name}")
            from src.intelligence.rulings import ingest_raw_document
            result = ingest_raw_document(path)
            self.print_fn(f"[Watcher] Document registered: {result.get('filename')}, "
                          f"extraction status: {result.get('extraction_status')}")

    def _archive(self, path: Path, subfolder: str):
        archive_dir = settings.archive_path / subfolder
        archive_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = archive_dir / f"{timestamp}_{path.name}"
        shutil.move(str(path), str(dest))
        self.print_fn(f"[Watcher] Archived to {dest}")


def start_watcher(print_fn=print) -> Observer:
    incoming = settings.incoming_path
    incoming.mkdir(parents=True, exist_ok=True)
    (incoming / "amazon").mkdir(exist_ok=True)
    (incoming / "shopify").mkdir(exist_ok=True)
    (incoming / "rulings").mkdir(exist_ok=True)

    handler = IncomingFileHandler(print_fn=print_fn)
    observer = Observer()
    observer.schedule(handler, str(incoming), recursive=True)
    observer.start()

    print_fn(f"[Watcher] Watching {incoming} for new files...")
    return observer
