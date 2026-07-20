import sys, os, json
from PyQt6.QtWidgets import (
    QApplication, QWidget, QHBoxLayout, QVBoxLayout,
    QTreeWidget, QTreeWidgetItem, QTextEdit, QPushButton,
    QFileDialog, QSlider, QLabel, QComboBox, QFrame, QMessageBox
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QTextCursor, QColor, QKeySequence, QShortcut, QFontDatabase

def get_base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = get_base_dir()
PROGRESS_FILE = os.path.join(BASE_DIR, "progress.json")
SETTINGS_FILE = os.path.join(BASE_DIR, "settings.json")


def find_webnovels_dir():
    candidates = [
        os.path.join(BASE_DIR, "webnovels"),
        os.path.join(os.path.dirname(BASE_DIR), "webnovels"),
        os.path.join(os.path.dirname(os.path.dirname(BASE_DIR)), "webnovels"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None

class SmoothScrollTextEdit(QTextEdit):
    def wheelEvent(self, event):
        # Scroll by pixel delta for smoother feel
        speed = 2  # Increase for faster scrolling
        delta = event.angleDelta().y() / 8  # 1 unit = 1 pixel
        bar = self.verticalScrollBar()
        bar.setValue(bar.value() - int(delta * speed))  # Ensure int for setValue
        event.accept()

class Reader(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Novel Reader")
        self.resize(1200, 700)

        self.volumes = {}
        self.current_item = None
        self.dark = False
        self.dark_bg = QColor("#2c2c2c")
        self.dark_alt = QColor("#3a3a3a")
        self.read_color = QColor("gray")
        self.font_size = 18
        self.line_spacing = 1.2
        self.sidebar_visible = True
        self.current_text_content = ""
        

        self.progress = self.load_progress()
        self.settings = self.load_settings()

        # Load Patrick Hand font
        if os.path.exists("PatrickHand-Regular.ttf"):
            QFontDatabase.addApplicationFont("PatrickHand-Regular.ttf")

        main_layout = QHBoxLayout(self)
        self.setLayout(main_layout)

        # Expand button (outside sidebar)
        self.expand_btn = QPushButton("⯇")
        self.expand_btn.setFixedWidth(25)
        self.expand_btn.clicked.connect(self.toggle_sidebar)
        self.expand_btn.setVisible(False)
        main_layout.insertWidget(0, self.expand_btn)

        # ------------------- Chapter Tree Sidebar -------------------
        self.sidebar_frame = QFrame()
        self.sidebar_layout = QVBoxLayout()
        self.sidebar_frame.setLayout(self.sidebar_layout)
        main_layout.addWidget(self.sidebar_frame)

        self.chapter_tree = QTreeWidget()
        self.chapter_tree.setHeaderHidden(True)
        self.chapter_tree.itemClicked.connect(self.open_chapter)
        self.sidebar_layout.addWidget(self.chapter_tree)

        # Collapse button
        self.collapse_btn = QPushButton("⯈")
        self.collapse_btn.setFixedWidth(25)
        self.collapse_btn.clicked.connect(self.toggle_sidebar)
        self.sidebar_layout.addWidget(self.collapse_btn)

        # ------------------- Reading Panel -------------------
        right_layout = QVBoxLayout()
        self.text = SmoothScrollTextEdit()
        self.text.setReadOnly(True)
        self.text.setAcceptRichText(True)
        self.text.setReadOnly(True)

        # Enable smoother scrolling for QTextEdit
        self.text.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.text.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.text.verticalScrollBar().setSingleStep(5)  # smaller = smoother
        self.text.verticalScrollBar().setPageStep(30)    # adjust for page up/down
        self.text.setCursorWidth(2)
        # Optionally, enable kinetic scrolling for touchpads (if supported)
        # self.text.setAttribute(Qt.WidgetAttribute.WA_AcceptTouchEvents, True)

        # Collapsible controls
        self.controls_frame = QFrame()
        self.controls_frame.setMaximumHeight(80)
        controls_layout = QHBoxLayout()
        self.controls_frame.setLayout(controls_layout)

        self.load_btn = QPushButton("Load Folder(s)")
        self.load_btn.clicked.connect(self.load_multiple_folders)
        controls_layout.addWidget(self.load_btn)
        self.theme_btn = QPushButton("Theme")
        self.theme_btn.clicked.connect(self.toggle_theme)

        self.last_read_btn = QPushButton("Last Read")
        self.last_read_btn.clicked.connect(self.go_to_last_read)
        controls_layout.addWidget(self.last_read_btn)

        self.font_box = QComboBox()
        self.font_box.addItems(["Georgia", "Times New Roman", "Arial", "Verdana", "Courier New", "Patrick Hand"])
        self.font_box.currentTextChanged.connect(self.change_font)
        self.font_label = QLabel("Font")

        self.size_slider = QSlider(Qt.Orientation.Horizontal)
        self.size_slider.setMinimum(8)
        self.size_slider.setMaximum(40)
        self.size_slider.setValue(self.settings.get("font_size", 18))
        self.size_slider.valueChanged.connect(self.change_size)
        self.size_label = QLabel("Size")

        self.spacing_slider = QSlider(Qt.Orientation.Horizontal)
        self.spacing_slider.setMinimum(5)
        self.spacing_slider.setMaximum(30)
        self.spacing_slider.setValue(int(self.settings.get("line_spacing", 1.2) * 10))
        self.spacing_slider.valueChanged.connect(self.change_spacing)
        self.spacing_label = QLabel("Spacing")

        controls_layout.addWidget(self.theme_btn)
        controls_layout.addWidget(self.font_label)
        controls_layout.addWidget(self.font_box)
        controls_layout.addWidget(self.size_label)
        controls_layout.addWidget(self.size_slider)
        controls_layout.addWidget(self.spacing_label)
        controls_layout.addWidget(self.spacing_slider)

        right_layout.addWidget(self.controls_frame)
        right_layout.addWidget(self.text)
        main_layout.addLayout(right_layout, 3)

        # Keyboard shortcuts
        QShortcut(QKeySequence(Qt.Key.Key_Right), self, self.next_chapter)
        QShortcut(QKeySequence(Qt.Key.Key_Left), self, self.prev_chapter)

        # Apply saved theme
        if self.settings.get("dark", False) != self.dark:
            self.toggle_theme()
        # Apply saved font
        self.font_box.setCurrentText(self.settings.get("font_name", "Georgia"))

        # Auto-load webnovels folder
        webnovels_path = find_webnovels_dir()
        if webnovels_path:
            self._add_folder_chapters(webnovels_path)
    
    def render_chapter(self):
        if not self.current_text_content:
            return

        lines = [l.strip() for l in self.current_text_content.splitlines() if l.strip()]
        html_paragraphs = "".join(f"<p>{line}</p>" for line in lines)

        html = f"""
        <html>
        <head>
        <style>
            body {{
                font-family: '{self.font_box.currentText()}';
                font-size: {self.size_slider.value()}pt;
                max-width: 800px;
                margin-left: auto;
                margin-right: auto;
            }}

            p {{
                margin: 0 0 18px 0;
                line-height: {self.spacing_slider.value()/10};
            }}
        </style>
        </head>
        <body>
        {html_paragraphs}
        </body>
        </html>
        """

        self.text.setHtml(html)

    # ------------------- Settings -------------------
    def load_settings(self):
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r") as f:
                return json.load(f)
        return {
            "font_name": "Georgia",
            "font_size": 18,
            "line_spacing": 1.2,
            "dark": False,
            "last_chapter_path": None
        }

    def save_settings(self):
        data = {
            "font_name": self.font_box.currentText(),
            "font_size": self.size_slider.value(),
            "line_spacing": self.spacing_slider.value() / 10,
            "dark": self.dark,
            "last_chapter_path": self.current_item.data(0, Qt.ItemDataRole.UserRole) if self.current_item else None
        }
        with open(SETTINGS_FILE, "w") as f:
            json.dump(data, f)

    # ------------------- Folder Loading -------------------
    def load_multiple_folders(self):
        folder = QFileDialog.getExistingDirectory(self, "Select Folder")
        if not folder:
            return
        self._add_folder_chapters(folder)

    def _add_folder_chapters(self, folder):
        # Check for subfolders (volumes)
        subfolders = [f for f in sorted(os.listdir(folder)) if os.path.isdir(os.path.join(folder, f))]
        if subfolders:
            for vol_name in subfolders:
                vol_path = os.path.join(folder, vol_name)
                if vol_name in self.volumes:
                    vol_item = self.volumes[vol_name]
                else:
                    vol_item = QTreeWidgetItem([vol_name])
                    vol_item.setExpanded(True)
                    self.volumes[vol_name] = vol_item
                    self.chapter_tree.addTopLevelItem(vol_item)
                self._add_chapters(vol_item, vol_path)
        else:
            vol_name = os.path.basename(folder)
            if vol_name in self.volumes:
                vol_item = self.volumes[vol_name]
            else:
                vol_item = QTreeWidgetItem([vol_name])
                vol_item.setExpanded(True)
                self.volumes[vol_name] = vol_item
                self.chapter_tree.addTopLevelItem(vol_item)
            self._add_chapters(vol_item, folder)

        # Auto-open last chapter if it exists
        last_path = self.settings.get("last_chapter_path")
        if last_path:
            for i in range(self.chapter_tree.topLevelItemCount()):
                vol_item = self.chapter_tree.topLevelItem(i)
                for j in range(vol_item.childCount()):
                    chapter_item = vol_item.child(j)
                    if chapter_item.data(0, Qt.ItemDataRole.UserRole) == last_path:
                        self.chapter_tree.setCurrentItem(chapter_item)
                        self.open_chapter(chapter_item)
                        break

    def _add_chapters(self, vol_item, folder_path):
        files = [f for f in os.listdir(folder_path) if f.endswith(".txt")]
        files.sort(key=lambda x: int(x.replace(".txt", "").lstrip("0")))
        for idx, file in enumerate(files):
            num = int(file.replace(".txt", "").lstrip("0"))
            chapter_item = QTreeWidgetItem([str(num)])
            path = os.path.join(folder_path, file)
            chapter_item.setData(0, Qt.ItemDataRole.UserRole, path)
            bg = self.dark_bg if self.dark and idx % 2 == 0 else \
                 self.dark_alt if self.dark else \
                 self.dark_bg if idx % 2 == 0 else self.dark_alt
            chapter_item.setBackground(0, bg)
            if str(num) in self.progress:
                chapter_item.setForeground(0, self.read_color)
            vol_item.addChild(chapter_item)

    # ------------------- Sidebar Toggle -------------------
    def toggle_sidebar(self):
        self.sidebar_visible = not self.sidebar_visible
        self.sidebar_frame.setVisible(self.sidebar_visible)
        self.collapse_btn.setText("⯈" if self.sidebar_visible else "⯊")
        self.expand_btn.setVisible(not self.sidebar_visible)

    # ------------------- Progress -------------------
    def load_progress(self):
        if os.path.exists(PROGRESS_FILE):
            with open(PROGRESS_FILE, "r") as f:
                return json.load(f)
        return {}

    def save_progress(self):
        with open(PROGRESS_FILE, "w") as f:
            json.dump(self.progress, f)

    def get_last_read_chapter(self):
        if not self.progress:
            return None
        read_chapters = [int(chap) for chap, read in self.progress.items() if read]
        if not read_chapters:
            return None
        return max(read_chapters)

    # ------------------- Open Chapter -------------------
    def open_chapter(self, item, _=None):
        if item.parent() is None:
            return

        path = item.data(0, Qt.ItemDataRole.UserRole)

        with open(path, "r", encoding="utf-8") as f:
            self.current_text_content = f.read()

        # render styled chapter
        self.render_chapter()

        self.progress[item.text(0)] = True
        self.save_progress()

        item.setForeground(0, self.read_color)

        self.current_item = item
        self.save_settings()

    # ------------------- Text Style -------------------
    def apply_text_style(self):
        font = self.text.font()
        font.setFamily(self.font_box.currentText())
        font.setPointSize(self.size_slider.value())
        self.text.setFont(font)
        cursor = self.text.textCursor()
        cursor.select(QTextCursor.SelectionType.Document)
        block_format = cursor.blockFormat()
        block_format.setLineHeight(self.spacing_slider.value() * 10, 2)
        cursor.setBlockFormat(block_format)
        cursor.clearSelection()
        self.save_settings()  # save style changes

    def change_font(self, name):
        self.render_chapter()
        self.save_settings()

    def change_size(self, size):
        self.render_chapter()
        self.save_settings()

    def change_spacing(self, value):
        self.render_chapter()
        self.save_settings()

    # ------------------- Theme -------------------
    def toggle_theme(self):
        if not self.dark:
            self.setStyleSheet("""
                QWidget { background-color: #121212; color: white; }
                QTextEdit { background-color: #1e1e1e; color: white; }
                QTreeWidget { background-color: #2c2c2c; color: white; }
            """)
        else:
            self.setStyleSheet("")
        self.dark = not self.dark
        # recolor chapter list
        for i in range(self.chapter_tree.topLevelItemCount()):
            vol_item = self.chapter_tree.topLevelItem(i)
            for j in range(vol_item.childCount()):
                chapter_item = vol_item.child(j)
                idx = j
                if chapter_item.text(0) in self.progress:
                    chapter_item.setForeground(0, self.read_color)
                else:
                    bg = self.dark_bg if self.dark and idx % 2 == 0 else \
                         self.dark_alt if self.dark else \
                         self.dark_bg if idx % 2 == 0 else self.dark_alt
                    chapter_item.setBackground(0, bg)
        self.save_settings()  # save theme change

    # ------------------- Keyboard Navigation -------------------
    def next_chapter(self):
        if not self.current_item: return
        item = self.chapter_tree.itemBelow(self.current_item)
        if item and item.parent():
            self.chapter_tree.setCurrentItem(item)
            self.open_chapter(item)

    def prev_chapter(self):
        if not self.current_item: return
        item = self.chapter_tree.itemAbove(self.current_item)
        if item and item.parent():
            self.chapter_tree.setCurrentItem(item)
            self.open_chapter(item)

    def go_to_last_read(self):
        last_chap = self.get_last_read_chapter()
        if last_chap is None:
            QMessageBox.information(self, "No Progress", "No chapters have been read yet.")
            return
        
        # Find the item in the tree
        for i in range(self.chapter_tree.topLevelItemCount()):
            vol_item = self.chapter_tree.topLevelItem(i)
            for j in range(vol_item.childCount()):
                chapter_item = vol_item.child(j)
                if chapter_item.text(0) == str(last_chap):
                    self.chapter_tree.setCurrentItem(chapter_item)
                    self.open_chapter(chapter_item)
                    return
        
        QMessageBox.information(self, "Not Found", f"Chapter {last_chap} not found in loaded folders.")

# ------------------- Run -------------------
app = QApplication(sys.argv)
reader = Reader()
reader.show()
sys.exit(app.exec())