import os
import re
import time
import unicodedata

import requests
from bs4 import BeautifulSoup

BOOK_NAME = "shadow slave update"
BOOK_SLUG = "shadow-slave"
BASE_URL = "https://freewebnovel.com/novel/{BOOK_SLUG}/chapter-{{}}"
MIN_CHAPTER = 2721
MAX_CHAPTER = 3110

# Add more ranges as needed. Chapters outside the known ranges will still be saved,
# but they will go into the fallback "unassigned" folder.
volumes = {
    "v11": (2721, 3000),
    "v12": (3001, 3110),
}

OUTPUT_ROOT = os.path.join(os.path.dirname(__file__), BOOK_NAME)
MISS_LIMIT_AFTER_TAIL = 6

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
}

# Watermark patterns (similar to cleaner script)
watermark_patterns = [
    re.compile(r'freewebnovel\.com', re.IGNORECASE),
    # Add more if needed
]

heading_pattern = re.compile(r"^(chapter|prologue|epilogue)\b", re.IGNORECASE)


def should_merge_lines(prev_line, next_line):
    if not prev_line:
        return False

    if len(prev_line) < 35 and heading_pattern.match(prev_line):
        return False

    if prev_line[-1] in ",:;-(":
        return True

    sentence_end = '.!?"\'”’)]'
    if prev_line[-1] not in sentence_end and next_line[:1].islower():
        return True

    return False


def format_paragraphs(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in text.split("\n")]

    paragraphs = []
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

def clean_text(text):
    # Normalize and remove watermarks
    text = unicodedata.normalize('NFKC', text)
    for pattern in watermark_patterns:
        text = pattern.sub('', text)
    # Keep clean paragraph spacing instead of flattening lines.
    text = format_paragraphs(text)
    return text

def ensure_output_folders():
    os.makedirs(OUTPUT_ROOT, exist_ok=True)
    for v in volumes:
        os.makedirs(os.path.join(OUTPUT_ROOT, v), exist_ok=True)
    os.makedirs(os.path.join(OUTPUT_ROOT, "unassigned"), exist_ok=True)


def make_output_path(chapter_num):
    vol = get_volume(chapter_num) or "unassigned"
    folder = os.path.join(OUTPUT_ROOT, vol)
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f"{chapter_num:04}.txt")

def get_volume(ch):
    for vol, (start, end) in volumes.items():
        if start <= ch <= end:
            return vol
    return None

ensure_output_folders()

if MIN_CHAPTER < 1:
    raise ValueError("MIN_CHAPTER must be at least 1")
if MIN_CHAPTER > MAX_CHAPTER:
    raise ValueError("MIN_CHAPTER cannot be greater than MAX_CHAPTER")

downloaded = 0
misses = 0

for chapter in range(MIN_CHAPTER, MAX_CHAPTER + 1):
    filename = make_output_path(chapter)

    # resume support
    if os.path.exists(filename):
        print(f"Skipping existing: {chapter}")
        downloaded += 1
        continue

    url = BASE_URL.format(chapter)
    print(f"Downloading: {url}")

    r = None
    # retry system
    for attempt in range(3):
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                break
        except requests.RequestException as e:
            print(f"Request error: {e}")

        print(f"Retrying {chapter} in 5s...")
        time.sleep(5)

    if not r or r.status_code != 200:
        print(f"Failed to download {chapter} (status: {r.status_code if r else 'N/A'})")
        misses += 1
        if misses >= MISS_LIMIT_AFTER_TAIL:
            print("Reached the end of the available chapters.")
            break
        continue

    misses = 0

    soup = BeautifulSoup(r.text, "html.parser")

    title = soup.find("h1")
    title_text = title.get_text(strip=True) if title else f"Chapter {chapter}"

    content = soup.find("div", id="article")
    if not content:
        print(f"No content found for {chapter}")
        continue

    text = content.get_text("\n\n")
    text = clean_text(text)

    with open(filename, "w", encoding="utf-8") as f:
        f.write(title_text + "\n\n")
        f.write(text)

    downloaded += 1
    print(f"Downloaded {chapter} ({downloaded})")
    time.sleep(1)  # Rate limiting

print("Finished downloading.")