import os
import re
import unicodedata

root_folders = [
    r"C:\Users\izaiah\OneDrive\Desktop\projects\webnovels\Lord of Mysteries",
    r"C:\Users\izaiah\OneDrive\Desktop\projects\webnovels\shadow slave"
]

# Pattern for the normalized watermark
pattern = re.compile(r'freewebnovel\.com', re.IGNORECASE)
translator_pattern = re.compile(r'Translator:\s*Atlas\s*Studios', re.IGNORECASE)
editor_pattern = re.compile(r'Editor:\s*Atlas\s*Studios', re.IGNORECASE)
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
    return "\n\n".join(paragraphs) + "\n"

files_checked = 0
total_removed = 0
files_formatted = 0

for root_folder in root_folders:
    for folder, _, files in os.walk(root_folder):
        for file in files:
            if file.endswith(".txt"):
                files_checked += 1
                path = os.path.join(folder, file)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        text = f.read()
                    
                    # Normalize to handle Unicode variations
                    normalized_text = unicodedata.normalize('NFKC', text)
                    
                    # Remove watermarks
                    count_watermarks = len(pattern.findall(normalized_text))
                    cleaned_text = pattern.sub('', normalized_text)
                    
                    # Remove translator and editor credits
                    count_translator = len(translator_pattern.findall(cleaned_text))
                    count_editor = len(editor_pattern.findall(cleaned_text))
                    cleaned_text = translator_pattern.sub('', cleaned_text)
                    cleaned_text = editor_pattern.sub('', cleaned_text)
                    formatted_text = format_paragraphs(cleaned_text)
                    
                    total_count = count_watermarks + count_translator + count_editor
                    changed = formatted_text != text
                    if total_count > 0 or changed:
                        total_removed += total_count
                        if changed:
                            files_formatted += 1
                        with open(path, "w", encoding="utf-8") as f:
                            f.write(formatted_text)
                        print(
                            f"Updated {path} (removed: {total_count}, watermarks: {count_watermarks}, "
                            f"translator: {count_translator}, editor: {count_editor}, formatted: {changed})"
                        )
                except Exception as e:
                    print(f"Error processing {path}: {e}")

print(f"Finished cleaning. Checked {files_checked} files.")
print(f"Total watermarks removed: {total_removed}")
print(f"Files with paragraph formatting updates: {files_formatted}")