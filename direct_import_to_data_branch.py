#!/usr/bin/env python3
"""
Bulk import .txt chapters directly into the Git-backed sync layout.

This bypasses website upload loops by writing chapter JSON files locally,
then you push one git commit to the data branch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple


def key_digest(sync_key: str) -> str:
    return hashlib.sha256(sync_key.encode("utf-8")).hexdigest()


def sort_key_for_path(p: Path) -> Tuple[int, str]:
    nums = re.findall(r"\d+", p.stem)
    if nums:
        try:
            return (int(nums[-1]), p.name.lower())
        except ValueError:
            pass
    return (10**12, p.name.lower())


def read_text_file(path: Path) -> str:
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def load_or_init_library(path: Path) -> Dict:
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("version", 1)
                data.setdefault("exportedAt", int(time.time() * 1000))
                data.setdefault("index", [])
                data.setdefault("progress", {"lastChapterId": None, "percents": {}})
                data.setdefault("settings", {})
                data.setdefault("booksMeta", {})
                return data
        except Exception as exc:
            raise RuntimeError(f"Failed to parse existing library file: {path} ({exc})") from exc

    return {
        "version": 1,
        "exportedAt": int(time.time() * 1000),
        "index": [],
        "progress": {"lastChapterId": None, "percents": {}},
        "settings": {},
        "booksMeta": {},
    }


def chapter_title_from_file(path: Path) -> str:
    stem = path.stem
    stem = stem.replace("_", " ").replace("-", " ")
    stem = re.sub(r"\s+", " ", stem).strip()
    return stem or path.name


def collect_txt_files(input_dir: Path, recursive: bool) -> List[Path]:
    if recursive:
        files = [p for p in input_dir.rglob("*.txt") if p.is_file()]
    else:
        files = [p for p in input_dir.glob("*.txt") if p.is_file()]
    files.sort(key=sort_key_for_path)
    return files


def parse_jobs_file(path: Path) -> Tuple[Optional[str], List[Dict]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Failed to parse jobs file {path}: {exc}") from exc

    if isinstance(payload, list):
        return None, payload

    if isinstance(payload, dict):
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            raise RuntimeError("jobs file object must include a 'jobs' array")
        sync_key = payload.get("syncKey")
        return (str(sync_key).strip() if sync_key else None), jobs

    raise RuntimeError("jobs file must be either an array or an object with a 'jobs' array")


def append_job_import(
    *,
    job_name: str,
    book_name: str,
    volume_name: Optional[str],
    input_dir: Path,
    recursive: bool,
    set_volume_on_existing: bool,
    index: List[Dict],
    existing_keys: set,
    to_write: List[Tuple[Path, Dict]],
    chapters_dir: Path,
) -> Dict[str, int]:
    files = collect_txt_files(input_dir, recursive=recursive)
    if not files:
        return {"found": 0, "added": 0, "skipped": 0}

    added_at_seed = int(time.time() * 1000)
    added = 0
    skipped = 0
    volume_updates = 0

    index_lookup: Dict[Tuple[str, str], Dict] = {}
    for entry in index:
        if not isinstance(entry, dict):
            continue
        title = (entry.get("title") or "").strip().lower()
        book = (entry.get("book") or "").strip()
        if title and book:
            index_lookup[(book, title)] = entry

    for i, file_path in enumerate(files):
        title = chapter_title_from_file(file_path)
        normalized_title = title.lower()
        existing_entry = index_lookup.get((book_name, normalized_title))
        if set_volume_on_existing and existing_entry is not None:
            if volume_name and (existing_entry.get("volume") or None) != volume_name:
                existing_entry["volume"] = volume_name
                volume_updates += 1
            skipped += 1
            continue

        dedupe_key = (book_name, (volume_name or ""), title.lower())
        if dedupe_key in existing_keys:
            skipped += 1
            continue

        content = read_text_file(file_path)
        chapter_id = str(uuid.uuid4())
        chapter_obj = {
            "title": title,
            "content": content,
        }

        to_write.append((chapters_dir / f"{chapter_id}.json", chapter_obj))
        index.append(
            {
                "id": chapter_id,
                "title": title,
                "book": book_name,
                "volume": volume_name,
                "addedAt": added_at_seed + i,
            }
        )
        existing_keys.add(dedupe_key)
        added += 1

    print(f"[{job_name}] Book: {book_name} | Volume: {volume_name or '(none)'}")
    print(f"[{job_name}] Input: {input_dir}")
    print(f"[{job_name}] Found txt files: {len(files)} | Will import: {added} | Skipped duplicates: {skipped} | Volume tags updated: {volume_updates}")

    return {"found": len(files), "added": added, "skipped": skipped, "volume_updates": volume_updates}


def main() -> int:
    parser = argparse.ArgumentParser(description="Import TXT chapters to sync-db layout for data branch push")
    parser.add_argument("--sync-key", default="", help="Reader sync key used by your app")
    parser.add_argument("--book", default="", help="Book name to assign to imported chapters")
    parser.add_argument("--input-dir", default="", help="Folder containing .txt chapter files")
    parser.add_argument("--volume", default="", help="Optional volume label for all chapters")
    parser.add_argument("--jobs-file", default="", help="Path to JSON file describing multiple import jobs")
    parser.add_argument("--prefix", default="sync-db", help="Sync prefix folder (default: sync-db)")
    parser.add_argument("--repo-root", default=".", help="Repository root path (default: current directory)")
    parser.add_argument("--recursive", action="store_true", help="Include txt files in nested folders")
    parser.add_argument("--set-volume-on-existing", action="store_true", help="When duplicate chapters are found, update their volume tag if needed")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing files")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    jobs: List[Dict] = []
    sync_key = (args.sync_key or "").strip()

    if args.jobs_file:
        jobs_path = Path(args.jobs_file).resolve()
        if not jobs_path.exists() or not jobs_path.is_file():
            print(f"jobs file not found: {jobs_path}")
            return 1
        file_sync_key, parsed_jobs = parse_jobs_file(jobs_path)
        if not sync_key and file_sync_key:
            sync_key = file_sync_key
        jobs = parsed_jobs
    else:
        if not args.book.strip() or not args.input_dir.strip():
            print("Single-job mode requires --book and --input-dir, or provide --jobs-file.")
            return 1
        jobs = [
            {
                "book": args.book,
                "inputDir": args.input_dir,
                "volume": args.volume,
                "recursive": args.recursive,
            }
        ]

    if not sync_key:
        print("Missing sync key. Provide --sync-key or include syncKey in jobs file.")
        return 1

    digest = key_digest(sync_key)
    root = repo_root / args.prefix.strip("/") / digest
    chapters_dir = root / "chapters"
    library_path = root / "library.json"

    library = load_or_init_library(library_path)
    index = library.get("index") if isinstance(library.get("index"), list) else []
    books_meta = library.get("booksMeta") if isinstance(library.get("booksMeta"), dict) else {}

    existing_keys = {
        ((entry.get("book") or "").strip(), (entry.get("volume") or "").strip(), (entry.get("title") or "").strip().lower())
        for entry in index
        if isinstance(entry, dict)
    }

    to_write: List[Tuple[Path, Dict]] = []
    total_found = 0
    total_added = 0
    total_skipped = 0
    total_volume_updates = 0

    for i, raw_job in enumerate(jobs, start=1):
        if not isinstance(raw_job, dict):
            print(f"Job #{i} is not an object; skipping.")
            continue

        book_name = (raw_job.get("book") or "").strip()
        input_dir_value = (raw_job.get("inputDir") or raw_job.get("input_dir") or "").strip()
        volume_name = (raw_job.get("volume") or "").strip() or None
        recursive = bool(raw_job.get("recursive", args.recursive))
        set_volume_on_existing = bool(raw_job.get("setVolumeOnExisting", args.set_volume_on_existing))
        job_name = (raw_job.get("name") or f"job-{i}").strip()

        if not book_name or not input_dir_value:
            print(f"[{job_name}] Missing required fields 'book' or 'inputDir'; skipping.")
            continue

        input_dir = Path(input_dir_value).resolve()
        if not input_dir.exists() or not input_dir.is_dir():
            print(f"[{job_name}] Input directory not found: {input_dir}")
            continue

        stats = append_job_import(
            job_name=job_name,
            book_name=book_name,
            volume_name=volume_name,
            input_dir=input_dir,
            recursive=recursive,
            set_volume_on_existing=set_volume_on_existing,
            index=index,
            existing_keys=existing_keys,
            to_write=to_write,
            chapters_dir=chapters_dir,
        )
        total_found += stats["found"]
        total_added += stats["added"]
        total_skipped += stats["skipped"]
        total_volume_updates += stats["volume_updates"]
        books_meta[book_name] = books_meta.get(book_name) or {"title": book_name, "coverDataUrl": ""}

    if total_added == 0 and total_volume_updates == 0:
        print("No new chapters to import after de-duplication, and no volume tags changed.")
        return 0

    index.sort(key=lambda e: ((e.get("book") or "").lower(), (e.get("volume") or "").lower(), int(e.get("addedAt") or 0)))

    library["index"] = index
    library["booksMeta"] = books_meta
    library["version"] = int(library.get("version") or 1)
    library["exportedAt"] = int(time.time() * 1000)

    print(f"Repo root: {repo_root}")
    print(f"Sync path: {root}")
    print(f"Total found txt files: {total_found}")
    print(f"Total will import: {total_added}")
    print(f"Total skipped duplicates: {total_skipped}")
    print(f"Total volume tags updated: {total_volume_updates}")

    if args.dry_run:
        print("Dry run only. No files written.")
        return 0

    chapters_dir.mkdir(parents=True, exist_ok=True)
    for out_path, chapter_obj in to_write:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(chapter_obj, ensure_ascii=False), encoding="utf-8")

    library_path.parent.mkdir(parents=True, exist_ok=True)
    library_path.write_text(json.dumps(library, ensure_ascii=False), encoding="utf-8")

    total_bytes = sum(p.stat().st_size for p, _ in to_write)
    print(f"Wrote chapter files: {len(to_write)}")
    print(f"Approx chapter payload bytes: {total_bytes}")
    print("Next: commit and push these changes to your data branch.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
