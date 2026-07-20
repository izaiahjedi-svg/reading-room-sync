import argparse
import os
import re
from pathlib import Path


HEADING_RE = re.compile(r"^(chapter|prologue|epilogue)\b", re.IGNORECASE)


def should_merge_lines(prev_line: str, next_line: str) -> bool:
    """Heuristic: merge wrapped lines but keep paragraph boundaries."""
    if not prev_line:
        return False

    if len(prev_line) < 35 and HEADING_RE.match(prev_line):
        return False

    prev_last = prev_line[-1]

    if prev_last in ",:;-(":
        return True

    sentence_end = '.!?"\'”’)]'
    if prev_last not in sentence_end and next_line[:1].islower():
        return True

    return False


def format_text(text: str) -> str:
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
    return "\n\n".join(paragraphs) + "\n"


def iter_txt_files(paths, recursive: bool):
    for raw_path in paths:
        path = Path(raw_path)
        if not path.exists():
            print(f"Skipping missing path: {path}")
            continue

        if path.is_file() and path.suffix.lower() == ".txt":
            yield path
            continue

        if path.is_dir():
            pattern = "**/*.txt" if recursive else "*.txt"
            yield from path.glob(pattern)


def format_file(path: Path, dry_run: bool = False) -> bool:
    original = path.read_text(encoding="utf-8", errors="ignore")
    updated = format_text(original)

    if updated == original:
        return False

    if not dry_run:
        path.write_text(updated, encoding="utf-8")

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Add/normalize paragraph spacing in scraped novel .txt files."
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="One or more .txt files or folders to format.",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Scan folders recursively for .txt files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without writing files.",
    )

    args = parser.parse_args()

    files_checked = 0
    files_changed = 0

    for txt_file in iter_txt_files(args.paths, recursive=args.recursive):
        files_checked += 1
        try:
            changed = format_file(txt_file, dry_run=args.dry_run)
            if changed:
                files_changed += 1
                action = "Would format" if args.dry_run else "Formatted"
                print(f"{action}: {txt_file}")
        except Exception as exc:
            print(f"Error processing {txt_file}: {exc}")

    print(f"Done. Checked {files_checked} file(s), changed {files_changed} file(s).")


if __name__ == "__main__":
    main()
