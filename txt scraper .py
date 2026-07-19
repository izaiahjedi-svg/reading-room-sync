import requests
from bs4 import BeautifulSoup
import os
import time
import re
import unicodedata

base_url = "https://freewebnovel.com/novel/omniscient-readers-viewpoint-novel/chapter-{}"

volumes = {
    "v1, Clown": (1, 189),
    "v2, Faceless": (190, 285),
    "v3, Traveler": (483, 732),
    "v4, Undying": (733, 946),
    "v5, Red Priest": (947, 1150),
    "v6, Lightseeker": (1151, 1266),
    "v7, The Hanged Man": (1267, 1353),
    "v8, Fool": (1354, 1394),
    "v9, Side Story An Ordinary Person's Daily Life": (1395, 1402),
    "v10, Side Story In Modern Day": (1403, 1430),
    "v11, Bonus Chapter That Corner": (1431, 1432)
}

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

# create volume folders
for v in volumes:
    os.makedirs(v, exist_ok=True)

def get_volume(ch):
    for vol, (start, end) in volumes.items():
        if start <= ch <= end:
            return vol
    return None

total_chapters = sum(end - start + 1 for start, end in volumes.values())
downloaded = 0

for chapter in range(1, 1433):  # Up to max chapter
    vol = get_volume(chapter)
    if not vol:
        continue

    filename = f"{vol}/{chapter:04}.txt"

    # resume support
    if os.path.exists(filename):
        print(f"Skipping existing: {chapter}")
        downloaded += 1
        continue

    url = base_url.format(chapter)
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
        continue

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
    print(f"Downloaded {chapter} ({downloaded}/{total_chapters})")
    time.sleep(1)  # Rate limiting

print("Finished downloading.")