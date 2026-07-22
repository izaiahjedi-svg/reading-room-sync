import os
import re
import time
import uuid
import unicodedata
from typing import Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup


# ------------------------------------------------------------
# Hardcoded ongoing books to keep updated.
# Add/remove entries here as needed.
# ------------------------------------------------------------
ONGOING_BOOKS = [
    {
    "book": "Shadow Slave",
    "aliases": ["Shadow Slave test"],
        "book_url": "https://freewebnovel.com/novel/shadow-slave",
        "start_chapter": 1,
        "lookback": 20,
        # Optional volume mapping: (volume_name, start, end)
        "volumes": [
            ("Volume 10", 2261, 2720),
            ("Volume 11", 2721, 3000),
            ("Volume 12", 3001, 3500),
        ],
    },
    # Example:
    # {
    #     "book": "Lord of Mysteries",
    #     "book_url": "https://freewebnovel.com/novel/lord-of-mysteries",
    #     "start_chapter": 1,
    #     "lookback": 8,
    #     "volumes": [
    #         ("Volume 1", 1, 213),
    #         ("Volume 2", 214, 482),
    #     ],
    # },
]

# Where your reader backend is running.
# Local server example: http://localhost:3000
# Netlify function example: https://your-site.netlify.app/.netlify/functions/library
# If using Netlify function base, set READER_SYNC_ENDPOINT to full function URL.
SYNC_BASE_URL = os.getenv("READER_SYNC_BASE_URL", "http://localhost:3000")
SYNC_ENDPOINT = os.getenv("READER_SYNC_ENDPOINT", "")
SYNC_KEY = os.getenv("READER_SYNC_KEY", "").strip()

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/127.0.0.0 Safari/537.36"
    )
}

MAX_CHAPTER_PROBE = 10000
MISS_LIMIT_AFTER_TAIL = 6
REQUEST_TIMEOUT = 15
REQUEST_RETRIES = 3
REQUEST_PAUSE_SECONDS = 0.9

WATERMARK_PATTERNS = [
    re.compile(r"freewebnovel\.com", re.IGNORECASE),
]
TRANSLATOR_PATTERN = re.compile(r"Translator:\s*Atlas\s*Studios", re.IGNORECASE)
EDITOR_PATTERN = re.compile(r"Editor:\s*Atlas\s*Studios", re.IGNORECASE)
HEADING_PATTERN = re.compile(r"^(chapter|prologue|epilogue)\b", re.IGNORECASE)
CHAPTER_NUM_PATTERN = re.compile(r"\bchapter\s*(\d{1,6})\b|\b(\d{1,6})\b", re.IGNORECASE)


def should_merge_lines(prev_line: str, next_line: str) -> bool:
    if not prev_line:
        return False

    if len(prev_line) < 35 and HEADING_PATTERN.match(prev_line):
        return False

    if prev_line[-1] in ",:;-(":
        return True

    sentence_end = '.!?"\'”’)]'
    if prev_line[-1] not in sentence_end and next_line[:1].islower():
        return True

    return False


def format_paragraphs(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in text.split("\n")]

    paragraphs: List[str] = []
    current = ""

    for line in lines:
        if not line:
            if current:
                paragraphs.append(current)
                current = ""
            continue

        if not current:
            current = line
            continue

        if should_merge_lines(current, line):
            current = f"{current} {line}"
        else:
            paragraphs.append(current)
            current = line

    if current:
        paragraphs.append(current)

    paragraphs = [re.sub(r"[ \t]+", " ", p).strip() for p in paragraphs if p.strip()]
    return "\n\n".join(paragraphs)


def clean_text(text: str) -> str:
    cleaned = unicodedata.normalize("NFKC", text)
    for pattern in WATERMARK_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    cleaned = TRANSLATOR_PATTERN.sub("", cleaned)
    cleaned = EDITOR_PATTERN.sub("", cleaned)
    return format_paragraphs(cleaned)


def parse_chapter_number(title: str) -> Optional[int]:
    if not title:
        return None
    match = CHAPTER_NUM_PATTERN.search(title)
    if not match:
        return None
    value = match.group(1) or match.group(2)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def volume_for_chapter(book_cfg: Dict, chapter_num: int) -> Optional[str]:
    for vol_name, start, end in book_cfg.get("volumes", []):
        if start <= chapter_num <= end:
            return vol_name
    return None


def get_sync_urls() -> Tuple[str, str]:
    if SYNC_ENDPOINT:
        get_url = f"{SYNC_ENDPOINT}?key={SYNC_KEY}"
        post_url = SYNC_ENDPOINT
        return get_url, post_url

    base = SYNC_BASE_URL.rstrip("/")
    return f"{base}/api/library?key={SYNC_KEY}", f"{base}/api/library"


def load_remote_library() -> Dict:
    get_url, _ = get_sync_urls()
    response = requests.get(get_url, timeout=REQUEST_TIMEOUT)
    if response.status_code != 200:
        raise RuntimeError(f"GET sync failed ({response.status_code}): {response.text[:200]}")

    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        data = {}

    data.setdefault("version", 1)
    data.setdefault("index", [])
    data.setdefault("chapters", {})
    data.setdefault("progress", {"lastChapterId": None, "percents": {}})
    data.setdefault("settings", {})
    data.setdefault("booksMeta", {})
    return data


def push_remote_library(data: Dict) -> None:
    _, post_url = get_sync_urls()
    headers = {"Content-Type": "application/json", "x-sync-key": SYNC_KEY}
    response = requests.post(post_url, json=data, headers=headers, timeout=REQUEST_TIMEOUT)
    if response.status_code != 200:
        raise RuntimeError(f"POST sync failed ({response.status_code}): {response.text[:200]}")


def load_remote_chapter(chapter_id: str) -> Optional[Dict[str, str]]:
    get_url, _ = get_sync_urls()
    if not get_url or not chapter_id:
        return None

    chapter_url = f"{get_url}&id={chapter_id}"
    response = requests.get(chapter_url, timeout=REQUEST_TIMEOUT)
    if response.status_code != 200:
        return None

    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    return data if isinstance(data, dict) else None


def fetch_chapter(book_url: str, chapter_num: int) -> Optional[Dict[str, str]]:
    chapter_url = f"{book_url.rstrip('/')}/chapter-{chapter_num}"

    for attempt in range(REQUEST_RETRIES):
        try:
            response = requests.get(chapter_url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT)
            if response.status_code == 404:
                return None
            if response.status_code != 200:
                if attempt == REQUEST_RETRIES - 1:
                    return None
                time.sleep(2)
                continue

            soup = BeautifulSoup(response.text, "html.parser")
            title_node = soup.find("h1")
            content_node = soup.find("div", id="article")
            if not content_node:
                return None

            raw_title = title_node.get_text(strip=True) if title_node else f"Chapter {chapter_num}"
            raw_text = content_node.get_text("\n\n")
            return {
                "title": raw_title,
                "content": clean_text(raw_text),
            }
        except requests.RequestException:
            if attempt == REQUEST_RETRIES - 1:
                return None
            time.sleep(2)

    return None


def build_existing_number_map(index: List[Dict], book_cfg: Dict) -> Dict[int, Dict]:
    mapping: Dict[int, Dict] = {}
    book_name = (book_cfg.get("book") or "").strip()
    aliases = {(a or "").strip() for a in book_cfg.get("aliases", []) if (a or "").strip()}
    allowed_names = {book_name} | aliases
    source_url = (book_cfg.get("book_url") or "").rstrip("/")

    for entry in index:
        entry_book = (entry.get("book") or "").strip()
        entry_source = (entry.get("sourceBookUrl") or "").rstrip("/")
        same_source = bool(source_url and entry_source and entry_source == source_url)
        if not same_source and entry_book not in allowed_names:
            continue

        number = parse_chapter_number(entry.get("title") or "")
        if number is not None:
            mapping[number] = entry
    return mapping


def ensure_book_meta(data: Dict, book_name: str) -> None:
    books_meta = data.get("booksMeta")
    if not isinstance(books_meta, dict):
        books_meta = {}
        data["booksMeta"] = books_meta
    if book_name not in books_meta:
        books_meta[book_name] = {"title": book_name, "coverDataUrl": ""}


def update_book(data: Dict, book_cfg: Dict) -> Dict[str, int]:
    index = data["index"]
    chapters = data["chapters"]
    book_name = book_cfg["book"]
    book_url = book_cfg["book_url"]
    start_chapter = int(book_cfg.get("start_chapter", 1))
    lookback = int(book_cfg.get("lookback", 8))

    ensure_book_meta(data, book_name)

    existing_map = build_existing_number_map(index, book_cfg)
    existing_numbers = sorted(existing_map.keys())
    max_existing = existing_numbers[-1] if existing_numbers else 0
    start_scan = max(start_chapter, max_existing - lookback + 1) if max_existing else start_chapter

    added = 0
    updated = 0
    unchanged = 0
    misses = 0

    print(f"\n[{book_name}] scanning from chapter {start_scan} (existing max: {max_existing or 'none'})")

    added_at_seed = int(time.time() * 1000)

    for chapter_num in range(start_scan, MAX_CHAPTER_PROBE + 1):
        result = fetch_chapter(book_url, chapter_num)
        if not result:
            if chapter_num > max_existing:
                misses += 1
                if misses >= MISS_LIMIT_AFTER_TAIL:
                    break
            continue

        misses = 0
        title = result["title"].strip() or f"Chapter {chapter_num}"
        content = result["content"].strip()
        volume = volume_for_chapter(book_cfg, chapter_num)

        if chapter_num in existing_map:
            entry = existing_map[chapter_num]
            chapter_id = entry["id"]
            chapter_data = load_remote_chapter(chapter_id) or chapters.get(chapter_id) or {}
            old_content = (chapter_data.get("content") or "").strip()
            old_title = (entry.get("title") or "").strip()
            old_volume = (entry.get("volume") or "")

            changed = False
            if old_title != title:
                entry["title"] = title
                changed = True
            if (entry.get("book") or "") != book_name:
                entry["book"] = book_name
                changed = True
            if (old_volume or "") != (volume or ""):
                entry["volume"] = volume
                changed = True
            if (entry.get("sourceBookUrl") or "") != book_url.rstrip('/'):
                entry["sourceBookUrl"] = book_url.rstrip('/')
                changed = True
            if old_content != content:
                changed = True

            if changed:
                chapters[chapter_id] = {"title": title, "content": content}
                updated += 1
                print(f"  updated chapter {chapter_num}: {title}")
            else:
                unchanged += 1
        else:
            chapter_id = str(uuid.uuid4())
            entry = {
                "id": chapter_id,
                "title": title,
                "book": book_name,
                "volume": volume,
                "sourceBookUrl": book_url.rstrip('/'),
                "addedAt": added_at_seed + added,
            }
            index.append(entry)
            chapters[chapter_id] = {"title": title, "content": content}
            existing_map[chapter_num] = entry
            added += 1
            print(f"  added chapter {chapter_num}: {title}")

        time.sleep(REQUEST_PAUSE_SECONDS)

    return {
        "added": added,
        "updated": updated,
        "unchanged": unchanged,
        "final_max": max(existing_map.keys()) if existing_map else 0,
    }


def main() -> None:
    if not SYNC_KEY:
        raise SystemExit("Set READER_SYNC_KEY before running.")

    print("Loading current library from sync backend...")
    data = load_remote_library()

    totals = {"added": 0, "updated": 0, "unchanged": 0}
    for cfg in ONGOING_BOOKS:
        stats = update_book(data, cfg)
        totals["added"] += stats["added"]
        totals["updated"] += stats["updated"]
        totals["unchanged"] += stats["unchanged"]
        print(
            f"[{cfg['book']}] done: +{stats['added']} new, {stats['updated']} updated, "
            f"{stats['unchanged']} unchanged, max={stats['final_max']}"
        )

    if totals["added"] == 0 and totals["updated"] == 0:
        print("No changes detected. Nothing to push.")
        return

    print("Pushing updated library to sync backend...")
    data["exportedAt"] = int(time.time() * 1000)
    push_remote_library(data)
    print(
        f"Sync complete. Added: {totals['added']}, Updated: {totals['updated']}, "
        f"Unchanged checked: {totals['unchanged']}"
    )


if __name__ == "__main__":
    main()
