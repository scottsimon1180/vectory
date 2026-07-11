from __future__ import annotations

import copy
import ctypes
import hashlib
import itertools
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree

from PySide6.QtCore import (
    QByteArray,
    QEvent,
    QObject,
    QPointF,
    QRectF,
    QSize,
    Qt,
    QTimer,
    Signal,
)
from PySide6.QtGui import (
    QAction,
    QColor,
    QCursor,
    QFont,
    QFontMetrics,
    QGuiApplication,
    QIcon,
    QKeySequence,
    QPainter,
    QPen,
    QPixmap,
    QPolygonF,
    QShortcut,
    QTextCursor,
)
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QFileDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QScrollBar,
    QScrollArea,
    QSlider,
    QTextEdit,
    QToolTip,
    QVBoxLayout,
    QWidget,
)


APP_TITLE = "Linked Icon Editor"
DEFAULT_GALLERY_HEADER = "Linked SVG Icon Gallery"
SOURCE_FILE_NAME = "ICONS (linked).js"
SINGLE_INSTANCE_SERVER_PREFIX = "linked-icon-editor"
WINDOWS_APP_USER_MODEL_ID = "LinkedIconEditor.IconEditor"
WINDOWS_MUTEX_NAME_PREFIX = r"Local\LinkedIconEditor.IconEditor"
BAR = "=" * 39
TEMPLATE_OPEN_RE = re.compile(r"const\s+rawIconsData\s*=\s*`")
CLOSING_BACKTICK_MARKER = "`; // DO NOT REMOVE THIS CLOSING BACKTICK!"
SMART_ENGINE_MARKER = "SMART INJECTION ENGINE"
EDITOR_CONFIG_RE = re.compile(
    r"/\*\s*LINKED_ICONS_EDITOR_CONFIG v1\s*\n(?P<body>.*?)\nEND_LINKED_ICONS_EDITOR_CONFIG\s*\*/",
    re.DOTALL,
)
BLOCK_RE = re.compile(
    rf"/\*\n={{{len(BAR)}}}\n(?P<name>[A-Za-z0-9_-]+)\n={{{len(BAR)}}}\n\*/\n\n\t(?P<svg><svg\b[^\n]*?</svg>)",
    re.IGNORECASE,
)
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DEFAULT_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    '<path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" '
    'stroke-width="2" stroke-linecap="round"/>'
    "</svg>"
)
APP_ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 992.493 1002.237"><g><g id="Layer_1" data-name="Layer 1"><polyline points="822.803 369.66 822.803 962.332 39.905 962.332 39.905 179.434 600.308 179.434" fill="none" stroke="#999" stroke-linecap="round" stroke-linejoin="round" stroke-width="79.811" transform="translate(13.133845, -13.151709)"/></g><g id="Layer_3_copy_8" data-name="Layer 3 copy 8"><g><polygon points="475.766 514.456 504.362 502.498 610.966 396.083 610.966 364.34 488.336 486.752 475.766 514.456" fill="#c4c4c4" transform="translate(13.133845, -13.151709)" stroke="none"/><path d="M709.109 757.419l-0.119 -0.217 -98.025 -169.57v-116.663l-76.54 76.404 -77.701 32.493c-4.488 1.959 -9.224 2.914 -13.938 2.914 -9.06 0 -18.036 -3.528 -25.008 -10.238 -10.806 -10.398 -14.217 -25.846 -8.691 -39.354l0.395 -0.916 34.578 -76.21 140.257 -140.008c-2.091 -0.415 -4.251 -0.638 -6.463 -0.638h-306.873c-18.257 0 -33.111 14.853 -33.111 33.11v145.549c-72.426 24.693 -124.662 93.396 -124.662 174.073 0 101.375 82.475 183.85 183.849 183.85 51.12 0 99.381 -21.039 134.156 -58.084h256.3c8.638 0 16.748 -4.624 21.165 -12.067 4.422 -7.449 4.585 -16.81 0.428 -24.428h0Z" fill="#c4c4c4" transform="translate(13.133845, -13.151709)" stroke="none"/></g></g><g id="Layer_3_copy_7" data-name="Layer 3 copy 7"><g><polygon points="475.766 514.456 504.362 502.498 605.057 401.981 605.057 370.238 488.336 486.752 475.766 514.456" fill="#767676" transform="translate(13.133845, -13.151709)" stroke="none"/><path d="M703.923 760.25l-0.083 -0.153 -98.782 -170.88v-112.349l-70.631 70.505 -77.701 32.493c-4.488 1.959 -9.224 2.914 -13.938 2.914 -9.06 0 -18.036 -3.528 -25.008 -10.238 -10.806 -10.398 -14.217 -25.846 -8.691 -39.354l0.395 -0.916 34.578 -76.21 134.948 -134.709c-0.383 -0.016 -0.767 -0.029 -1.154 -0.029h-306.873c-14.999 0 -27.202 12.203 -27.202 27.202v149.827c-72.171 22.696 -124.662 90.23 -124.662 169.795 0 98.117 79.824 177.941 177.94 177.941 50.334 0 97.813 -21.063 131.591 -58.084h258.864c6.563 0 12.726 -3.515 16.085 -9.173 3.413 -5.75 3.534 -12.699 0.322 -18.582h0.002Z" fill="#767676" transform="translate(13.133845, -13.151709)" stroke="none"/></g></g><g id="Layer_3_copy_6" data-name="Layer 3 copy 6"><g><path d="M703.839 760.097l-98.782 -170.88v-112.349l-28.335 28.285v35.049l-12.847 -22.225 -20.753 20.716 127.742 220.977h-291.712l112.079 -194.234 -34.506 14.43c-4.488 1.959 -9.224 2.914 -13.938 2.914 -9.06 0 -18.036 -3.528 -25.008 -10.238 -10.806 -10.398 -14.217 -25.846 -8.691 -39.354l0.395 -0.916 0.662 -1.459c-4.357 -3.579 -8.886 -6.978 -13.599 -10.161 -29.495 -19.917 -63.897 -30.444 -99.486 -30.444h0c-8.461 0 -16.793 0.595 -24.943 1.743v-142.291h278.536l28.357 -28.307c-0.383 -0.016 -0.767 -0.029 -1.154 -0.029h-306.873c-15 0 -27.202 12.203 -27.202 27.202v149.828c-72.17 22.695 -124.662 90.23 -124.662 169.795 0 98.117 79.825 177.941 177.941 177.941h0c50.334 0 97.812 -21.063 131.591 -58.084h258.864c6.563 0 12.726 -3.516 16.084 -9.174 3.414 -5.75 3.534 -12.697 0.323 -18.582l-0.083 -0.153ZM297.06 817.755c-82.494 0 -149.606 -67.114 -149.606 -149.606s67.113 -149.605 149.606 -149.605h0c59.43 0 112.958 34.937 137.036 89.215l-87.823 152.197 -0.165 0.295c-3.211 5.884 -3.091 12.831 0.322 18.582 3.358 5.658 9.522 9.174 16.085 9.174h24.152c-25.636 19.173 -56.906 29.749 -89.608 29.749Z" fill="#999" transform="translate(13.133845, -13.151709)" stroke="none"/><path d="M508.953 478.058l-0.167 0.262 -16.981 29.428 12.556 -5.251 30.522 -30.468c-2.728 -1.731 -5.902 -2.738 -9.277 -2.853 -6.645 -0.223 -13.019 3.178 -16.654 8.881Z" fill="#999" transform="translate(13.133845, -13.151709)" stroke="none"/><polygon points="605.057 370.238 576.722 398.523 576.722 430.267 605.057 401.981 605.057 370.238" fill="#999" transform="translate(13.133845, -13.151709)" stroke="none"/></g></g><g id="Layer_2" data-name="Layer 2"><path id="yellow" d="M153.355 668.166c0 79.241 64.463 143.687 143.696 143.687 24.701 0 48.549 -6.296 69.589 -17.937h-4.132c-8.632 0 -16.746 -4.618 -21.165 -12.059 -4.419 -7.449 -4.584 -16.806 -0.432 -24.428l0.233 -0.423 86.306 -149.563c-0.011 -0.025 -0.022 -0.05 -0.034 -0.074 -0.701 -1.494 -1.426 -2.972 -2.177 -4.438 -0.027 -0.052 -0.052 -0.106 -0.08 -0.158 -11.079 -21.566 -27.445 -40.007 -47.778 -53.736 -23.815 -16.081 -51.584 -24.575 -80.32 -24.575 -79.241 0 -143.704 64.463 -143.704 143.704h0Z" fill="#fc0" transform="translate(13.133845, -13.151709)" stroke="none"/></g><g id="Layer_3_copy" data-name="Layer 3 copy"><g><path d="M570.811 404.423l-82.475 82.329 -12.57 27.704 7.04 -2.944 20.919 -36.252 0.233 -0.371c4.748 -7.467 13.112 -11.912 21.839 -11.619 4.92 0.167 9.519 1.765 13.351 4.504l31.664 -31.608v-31.743Z" fill="#f33" transform="translate(13.133845, -13.151709)" stroke="none"/><path d="M444.06 456.063l100.671 -100.493h-266.706v129.716h0c6.311 -0.651 12.666 -0.986 19.025 -0.986 36.772 0 72.317 10.877 102.792 31.456 4.428 2.99 8.699 6.166 12.824 9.497l31.392 -69.189Z" fill="#f33" transform="translate(13.133845, -13.151709)" stroke="none"/><polygon points="568.197 513.663 570.811 518.187 570.811 511.053 568.197 513.663" fill="#f33" transform="translate(13.133845, -13.151709)" stroke="none"/></g></g><g id="Layer_3_copy_5" data-name="Layer 3 copy 5"><polygon points="534.426 547.373 500.224 561.676 389.378 753.76 660.61 753.76 538.793 543.014 534.426 547.373" fill="#39f" transform="translate(13.133845, -13.151709)" stroke="none"/></g><g id="Layer_3" data-name="Layer 3"><path d="M519.394 524.936l374.701 -374.036 -53.196 -53.529 -374.701 374.036 -32.583 71.815c-2.992 7.314 5.32 15.626 12.634 12.302l73.145 -30.588ZM921.69 123.97l31.585 -31.253c15.959 -15.959 16.956 -32.915 2.66 -47.212l-9.309 -9.309c-13.964 -13.964 -31.253 -12.634 -46.879 2.992l-31.585 31.253 53.529 53.529Z" fill="#999" transform="translate(13.133845, -13.151709)" stroke="none"/></g></g></svg>"""
TILE_DEFAULT_SIZE = 102
TILE_ZOOM_MIN = 56
TILE_ZOOM_MAX = 176
TILE_ZOOM_STEP = 8
TILE_ZOOM_WHEEL_STEP = 6
TILE_GRID_GAP = 14
TILE_LABEL_MIN_SIZE = 78
EDITOR_PANEL_WIDTH = 430
MAIN_WINDOW_MIN_WIDTH = 1220
MAIN_WINDOW_MIN_HEIGHT = 620
CONFIRMATION_FLASH_STEPS = 10
CONFIRMATION_FLASH_FADE_IN_MS = 200
CONFIRMATION_FLASH_HOLD_MS = 700
CONFIRMATION_FLASH_FADE_OUT_MS = 200
CONFIRMATION_FLASH_DURATION_MS = (
    CONFIRMATION_FLASH_FADE_IN_MS + CONFIRMATION_FLASH_HOLD_MS + CONFIRMATION_FLASH_FADE_OUT_MS
)
CONFIRMATION_FLASH_DEFAULT_COLOR = "#3a3a42"
CONFIRMATION_FLASH_RING_WIDTH = 2.0
CONFIRMATION_FLASH_RING_RADIUS = 14.0
CONFIRMATION_FLASH_COPY_COLOR = "#34c759"
CONFIRMATION_FLASH_PASTE_COLOR = "#007aff"
CONFIRMATION_FLASH_CLEAR_COLOR = "#ff3b30"
ICON_HISTORY_COALESCE_MS = 750
_ICON_UID_COUNTER = itertools.count(1)


@dataclass(frozen=True)
class EditorConfig:
    app_title: str = APP_TITLE
    gallery_header: str = DEFAULT_GALLERY_HEADER
    header_icon_svg: str = APP_ICON_SVG


class IconFormatError(RuntimeError):
    pass


@dataclass(frozen=True)
class IconRecord:
    name: str
    svg: str
    uid: int = field(default_factory=lambda: next(_ICON_UID_COUNTER))


@dataclass(frozen=True)
class IconHistoryState:
    name: str
    svg: str
    edit_field: str | None = None
    cursor_position: int = 0
    anchor_position: int = 0
    before_cursor_position: int = 0
    before_anchor_position: int = 0
    edit_group: int | None = None

    @classmethod
    def from_icon(
        cls,
        icon: IconRecord,
        *,
        edit_field: str | None = None,
        cursor_position: int = 0,
        anchor_position: int = 0,
        before_cursor_position: int = 0,
        before_anchor_position: int = 0,
        edit_group: int | None = None,
    ) -> IconHistoryState:
        return cls(
            icon.name,
            icon.svg,
            edit_field,
            cursor_position,
            anchor_position,
            before_cursor_position,
            before_anchor_position,
            edit_group,
        )

    def same_content(self, other: IconHistoryState) -> bool:
        return self.name == other.name and self.svg == other.svg


@dataclass(frozen=True)
class IconHistoryRestore:
    name: str
    svg: str
    edit_field: str | None
    cursor_position: int
    anchor_position: int


@dataclass
class IconHistory:
    states: list[IconHistoryState]
    position: int = 0

    @classmethod
    def for_icon(cls, icon: IconRecord) -> IconHistory:
        return cls([IconHistoryState.from_icon(icon)])

    @property
    def current(self) -> IconHistoryState:
        return self.states[self.position]

    @property
    def can_undo(self) -> bool:
        return self.position > 0

    @property
    def can_redo(self) -> bool:
        return self.position + 1 < len(self.states)

    def record(
        self,
        icon: IconRecord,
        *,
        edit_field: str,
        cursor_position: int,
        anchor_position: int,
        edit_group: int,
        before_cursor_position: int = 0,
        before_anchor_position: int = 0,
    ) -> bool:
        state = IconHistoryState.from_icon(
            icon,
            edit_field=edit_field,
            cursor_position=cursor_position,
            anchor_position=anchor_position,
            before_cursor_position=before_cursor_position,
            before_anchor_position=before_anchor_position,
            edit_group=edit_group,
        )
        if state.same_content(self.current):
            return False

        had_redo = self.can_redo
        if had_redo:
            del self.states[self.position + 1 :]

        if not had_redo and self.current.edit_group == edit_group:
            previous_state = self.current
            self.states[self.position] = IconHistoryState(
                state.name,
                state.svg,
                state.edit_field,
                state.cursor_position,
                state.anchor_position,
                previous_state.before_cursor_position,
                previous_state.before_anchor_position,
                state.edit_group,
            )
        else:
            self.states.append(state)
            self.position += 1

        if self.position > 0 and self.current.same_content(self.states[self.position - 1]):
            del self.states[self.position]
            self.position -= 1
        return True

    def undo(self) -> IconHistoryRestore | None:
        if not self.can_undo:
            return None

        undone = self.current
        self.position -= 1
        target = self.current
        return IconHistoryRestore(
            target.name,
            target.svg,
            undone.edit_field,
            undone.before_cursor_position,
            undone.before_anchor_position,
        )

    def redo(self) -> IconHistoryRestore | None:
        if not self.can_redo:
            return None

        self.position += 1
        target = self.current
        return IconHistoryRestore(
            target.name,
            target.svg,
            target.edit_field,
            target.cursor_position,
            target.anchor_position,
        )

    def reconcile_current(self, icon: IconRecord) -> None:
        current = self.current
        normalized = IconHistoryState.from_icon(
            icon,
            edit_field=current.edit_field,
            cursor_position=current.cursor_position,
            anchor_position=current.anchor_position,
            before_cursor_position=current.before_cursor_position,
            before_anchor_position=current.before_anchor_position,
            edit_group=current.edit_group,
        )
        self.states[self.position] = normalized

        while self.position > 0 and self.states[self.position - 1].same_content(normalized):
            del self.states[self.position]
            self.position -= 1
        while self.can_redo and self.states[self.position + 1].same_content(normalized):
            del self.states[self.position + 1]

def to_lf(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def detect_newline(value: str) -> str:
    return "\r\n" if "\r\n" in value else "\n"


def line_number_at(value: str, index: int) -> int:
    return value.count("\n", 0, max(index, 0)) + 1


def normalize_name_live(value: str) -> str:
    text = str(value or "").lower()
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"[^a-z0-9-]+", "-", text)
    text = re.sub(r"-{2,}", "-", text)
    text = re.sub(r"^-+", "", text)
    return text


def normalize_name_final(value: str) -> str:
    return normalize_name_live(value).strip("-")


def normalize_svg_line(svg_text: str) -> str:
    text = str(svg_text or "").strip()
    text = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", text, flags=re.IGNORECASE)
    text = text.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    text = re.sub(r">\s+<", "><", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def validate_svg_text(svg_text: str) -> tuple[bool, str, str]:
    svg = normalize_svg_line(svg_text)

    if not svg:
        return False, "SVG code is empty.", svg
    if not re.match(r"^<svg(?:\s|>)", svg, flags=re.IGNORECASE):
        return False, "SVG code must start with an <svg> element.", svg
    if not re.search(r"</svg>\s*$", svg, flags=re.IGNORECASE):
        return False, "SVG code must end with </svg>.", svg
    if "`" in svg or "${" in svg:
        return False, "SVG code cannot contain a backtick or ${ because linked_icons.js stores SVGs in a template literal.", svg
    if "\\" in svg:
        return False, "SVG code cannot contain a backslash because linked_icons.js stores SVGs in a template literal.", svg
    if re.search(r"<\s*(script|foreignObject)\b", svg, flags=re.IGNORECASE):
        return False, "SVG code cannot contain script or foreignObject elements.", svg

    try:
        root = ElementTree.fromstring(svg)
    except ElementTree.ParseError as error:
        return False, f"SVG XML is invalid: {error}.", svg

    if xml_local_name(root.tag) != "svg":
        return False, "The root element must be <svg>.", svg

    for element in root.iter():
        for attr_name in element.attrib:
            if xml_local_name(attr_name).startswith("on"):
                return False, "SVG code cannot contain inline event handler attributes.", svg

    return True, "", svg


def parse_editor_config(suffix: str) -> EditorConfig:
    match = EDITOR_CONFIG_RE.search(to_lf(suffix))
    if not match:
        return EditorConfig()

    values: dict[str, str] = {}
    for line in match.group("body").splitlines():
        key, separator, value = line.strip().partition(":")
        if separator and key in {"app_title", "gallery_header", "header_icon_svg"}:
            values[key] = value.strip()

    app_title = values.get("app_title") or APP_TITLE
    gallery_header = values.get("gallery_header") or DEFAULT_GALLERY_HEADER
    header_icon_svg = APP_ICON_SVG

    svg_value = values.get("header_icon_svg", "")
    if svg_value and "*/" not in svg_value:
        valid, _, normalized_svg = validate_svg_text(svg_value)
        if valid:
            header_icon_svg = normalized_svg

    return EditorConfig(app_title=app_title, gallery_header=gallery_header, header_icon_svg=header_icon_svg)


def icon_sort_key(icon: IconRecord) -> tuple[int, str]:
    return (0 if icon.name[:1].isdigit() else 1, icon.name)


def sorted_icons(icons: Iterable[IconRecord]) -> list[IconRecord]:
    return sorted(icons, key=icon_sort_key)


def unique_icon_name(base: str, used: set[str]) -> str:
    name = base
    counter = 2
    while name in used:
        name = f"{base}-{counter}"
        counter += 1
    return name


def display_name(name: str, width: int, font_metrics: QFontMetrics) -> str:
    return font_metrics.elidedText(name, Qt.TextElideMode.ElideRight, width)


def preview_svg(svg: str, color: str) -> str:
    return re.sub(r"currentcolor", color, svg, flags=re.IGNORECASE)


def parse_svg_number(value: str | None) -> float | None:
    if not value:
        return None

    text = value.strip()
    if text.endswith("%"):
        return None

    match = re.match(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text)
    if not match:
        return None

    number = float(match.group(0))
    return number if number > 0 else None


def svg_artboard_size(svg: str, renderer: QSvgRenderer | None = None) -> tuple[float, float]:
    try:
        root = ElementTree.fromstring(svg)
    except ElementTree.ParseError:
        return (1.0, 1.0)

    view_box = root.attrib.get("viewBox") or root.attrib.get("viewbox")
    if view_box:
        parts = [part for part in re.split(r"[\s,]+", view_box.strip()) if part]
        if len(parts) == 4:
            try:
                width = float(parts[2])
                height = float(parts[3])
            except ValueError:
                width = 0.0
                height = 0.0
            if width > 0 and height > 0:
                return (width, height)

    width = parse_svg_number(root.attrib.get("width"))
    height = parse_svg_number(root.attrib.get("height"))
    if width and height:
        return (width, height)

    if renderer is not None:
        default_size = renderer.defaultSize()
        if default_size.isValid() and default_size.width() > 0 and default_size.height() > 0:
            return (float(default_size.width()), float(default_size.height()))

    return (1.0, 1.0)


def fit_rect_to_aspect(bounds: QRectF, width: float, height: float) -> QRectF:
    if width <= 0 or height <= 0:
        width = 1.0
        height = 1.0

    aspect = width / height
    bounds_aspect = bounds.width() / bounds.height() if bounds.height() else 1.0

    if aspect >= bounds_aspect:
        fitted_width = bounds.width()
        fitted_height = fitted_width / aspect
    else:
        fitted_height = bounds.height()
        fitted_width = fitted_height * aspect

    return QRectF(
        bounds.x() + ((bounds.width() - fitted_width) / 2),
        bounds.y() + ((bounds.height() - fitted_height) / 2),
        fitted_width,
        fitted_height,
    )


def render_svg_pixmap(svg: str, side: int, color: str = "#9b9ba3") -> QPixmap:
    ratio = max(1.0, QGuiApplication.primaryScreen().devicePixelRatio() if QGuiApplication.primaryScreen() else 1.0)
    pixmap = QPixmap(round(side * ratio), round(side * ratio))
    pixmap.setDevicePixelRatio(ratio)
    pixmap.fill(Qt.GlobalColor.transparent)

    data = QByteArray(preview_svg(svg, color).encode("utf-8"))
    renderer = QSvgRenderer(data)
    if not renderer.isValid():
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor("#ff6b61"))
        painter.setFont(QFont("Segoe UI", max(8, side // 6), QFont.Weight.DemiBold))
        painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "!")
        painter.end()
        return pixmap

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    margin = max(4, side // 10)
    renderer.render(painter, QRectF(margin, margin, side - (margin * 2), side - (margin * 2)))
    painter.end()
    return pixmap


def render_svg_artboard_pixmap(svg: str, side: int, color: str = "#9b9ba3") -> QPixmap:
    ratio = max(1.0, QGuiApplication.primaryScreen().devicePixelRatio() if QGuiApplication.primaryScreen() else 1.0)
    pixmap = QPixmap(round(side * ratio), round(side * ratio))
    pixmap.setDevicePixelRatio(ratio)
    pixmap.fill(Qt.GlobalColor.transparent)

    data = QByteArray(preview_svg(svg, color).encode("utf-8"))
    renderer = QSvgRenderer(data)
    if not renderer.isValid():
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor("#ff6b61"))
        painter.setFont(QFont("Segoe UI", max(8, side // 6), QFont.Weight.DemiBold))
        painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, "!")
        painter.end()
        return pixmap

    margin = max(4, side // 10)
    bounds = QRectF(margin, margin, side - (margin * 2), side - (margin * 2))
    board_width, board_height = svg_artboard_size(svg, renderer)
    artboard_rect = fit_rect_to_aspect(bounds, board_width, board_height)
    border_rect = artboard_rect.adjusted(0.5, 0.5, -0.5, -0.5)

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
    renderer.render(painter, artboard_rect)
    painter.setPen(QPen(QColor("#5d5d68"), 1.2))
    painter.setBrush(Qt.BrushStyle.NoBrush)
    painter.drawRect(border_rect)
    painter.end()
    return pixmap


def render_invalid_pixmap(side: int, text: str = "Invalid") -> QPixmap:
    ratio = max(1.0, QGuiApplication.primaryScreen().devicePixelRatio() if QGuiApplication.primaryScreen() else 1.0)
    pixmap = QPixmap(round(side * ratio), round(side * ratio))
    pixmap.setDevicePixelRatio(ratio)
    pixmap.fill(Qt.GlobalColor.transparent)

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setRenderHint(QPainter.RenderHint.TextAntialiasing)
    painter.setPen(QPen(QColor("#ff6b61"), 2))
    painter.setBrush(QColor(255, 107, 97, 20))
    rect = QRectF(8, 8, side - 16, side - 16)
    painter.drawRoundedRect(rect, 14, 14)
    painter.setFont(QFont("Segoe UI", max(8, side // 11), QFont.Weight.DemiBold))
    painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, text)
    painter.end()
    return pixmap


def repolish(widget: QWidget) -> None:
    widget.style().unpolish(widget)
    widget.style().polish(widget)
    widget.update()


def set_windows_app_user_model_id() -> None:
    if sys.platform != "win32":
        return

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(ctypes.c_wchar_p(WINDOWS_APP_USER_MODEL_ID))
    except (AttributeError, OSError):
        pass


def build_svg_icon(svg: str) -> QIcon:
    renderer = QSvgRenderer(QByteArray(svg.encode("utf-8")))
    icon = QIcon()

    if not renderer.isValid():
        return icon

    for side in (16, 20, 24, 32, 40, 48, 64, 96, 128, 256):
        pixmap = QPixmap(side, side)
        pixmap.fill(Qt.GlobalColor.transparent)

        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        renderer.render(painter, QRectF(0, 0, side, side))
        painter.end()

        icon.addPixmap(pixmap)

    return icon


def build_app_icon() -> QIcon:
    return build_svg_icon(APP_ICON_SVG)


def single_instance_names(source_path: Path) -> tuple[str, str]:
    identity_path = os.path.normcase(str(source_path.resolve()))
    digest = hashlib.sha256(identity_path.encode("utf-8")).hexdigest()[:16]
    return (
        f"{SINGLE_INSTANCE_SERVER_PREFIX}-{digest}",
        f"{WINDOWS_MUTEX_NAME_PREFIX}.{digest}",
    )


class SingleInstanceGuard(QObject):
    def __init__(self, server_name: str, mutex_name: str, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.server_name = server_name
        self.mutex_name = mutex_name
        self.server = QLocalServer(self)
        self.window: QMainWindow | None = None
        self.mutex_handle: int | None = None
        self.notified_existing_instance = False
        self.listen_error = ""
        self.server.newConnection.connect(self._on_new_connection)

    def acquire(self) -> bool:
        if sys.platform == "win32":
            if not self._acquire_windows_mutex():
                self.notified_existing_instance = self.notify_existing_instance(self.server_name)
                if not self.notified_existing_instance:
                    self.notified_existing_instance = True
                    self.listen_error = "Another instance is already running, but its window could not be activated."
                return False

            QLocalServer.removeServer(self.server_name)
            if self.server.listen(self.server_name):
                return True

            self.release()
            self.listen_error = self.server.errorString()
            return False

        if self.server.listen(self.server_name):
            return True

        if self.notify_existing_instance(self.server_name):
            self.notified_existing_instance = True
            return False

        QLocalServer.removeServer(self.server_name)
        if self.server.listen(self.server_name):
            return True

        self.listen_error = self.server.errorString()
        return False

    def release(self) -> None:
        if self.mutex_handle is None or sys.platform != "win32":
            return

        try:
            ctypes.windll.kernel32.CloseHandle(self.mutex_handle)
        except (AttributeError, OSError):
            pass
        self.mutex_handle = None

    def set_window(self, window: QMainWindow) -> None:
        self.window = window

    def _acquire_windows_mutex(self) -> bool:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_bool

        ctypes.set_last_error(0)
        handle = kernel32.CreateMutexW(None, False, self.mutex_name)
        last_error = ctypes.get_last_error()
        if not handle:
            self.listen_error = f"Could not create the single-instance mutex. Windows error {last_error}."
            return False

        if last_error == 183:  # ERROR_ALREADY_EXISTS
            kernel32.CloseHandle(handle)
            return False

        self.mutex_handle = handle
        return True

    @staticmethod
    def notify_existing_instance(server_name: str) -> bool:
        socket = QLocalSocket()
        socket.connectToServer(server_name)

        if not socket.waitForConnected(250):
            socket.abort()
            return False

        socket.write(b"activate")
        socket.flush()
        socket.waitForBytesWritten(250)
        socket.disconnectFromServer()
        return True

    def _on_new_connection(self) -> None:
        while self.server.hasPendingConnections():
            socket = self.server.nextPendingConnection()
            socket.disconnectFromServer()
            socket.deleteLater()

        QTimer.singleShot(0, self.activate_window)

    def activate_window(self) -> None:
        if self.window is None:
            return

        if self.window.isMinimized():
            self.window.showNormal()
        else:
            self.window.show()

        self.window.raise_()
        self.window.activateWindow()

        if sys.platform != "win32":
            return

        try:
            hwnd = int(self.window.winId())
            if ctypes.windll.user32.IsIconic(hwnd):
                ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            ctypes.windll.user32.SetForegroundWindow(hwnd)
        except (AttributeError, OSError, TypeError, ValueError):
            pass


class PolishedScrollBar(QScrollBar):
    THICKNESS = 10
    HANDLE_THICKNESS = 6
    BUTTON_LENGTH = 18
    MIN_HANDLE_LENGTH = 44

    def __init__(self, orientation: Qt.Orientation, parent: QWidget | None = None, background: str = "#202024") -> None:
        super().__init__(orientation, parent)
        self._background = QColor(background)
        self.setObjectName("PolishedScrollBar")
        self.setMouseTracking(True)
        self.setAutoFillBackground(False)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt method name
        if self.orientation() == Qt.Orientation.Vertical:
            return QSize(self.THICKNESS, 92)
        return QSize(92, self.THICKNESS)

    def minimumSizeHint(self) -> QSize:  # noqa: N802 - Qt method name
        return self.sizeHint()

    def enterEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self.update()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self.update()
        super().leaveEvent(event)

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self.update()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt method name
        super().mouseReleaseEvent(event)
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 - Qt method name
        super().mouseMoveEvent(event)
        self.update()

    def sliderChange(self, change) -> None:  # noqa: N802 - Qt method name
        super().sliderChange(change)
        self.update()

    def _handle_rect(self) -> QRectF:
        vertical = self.orientation() == Qt.Orientation.Vertical
        length = self.height() if vertical else self.width()
        breadth = self.width() if vertical else self.height()
        available = max(1, length - (self.BUTTON_LENGTH * 2))

        if self.maximum() <= self.minimum():
            handle_length = available
            handle_start = self.BUTTON_LENGTH
        else:
            handle_length = max(
                self.MIN_HANDLE_LENGTH,
                round(available * self.pageStep() / (self.maximum() - self.minimum() + self.pageStep())),
            )
            handle_length = min(handle_length, available)
            travel = max(1, available - handle_length)
            ratio = (self.value() - self.minimum()) / max(1, self.maximum() - self.minimum())
            handle_start = self.BUTTON_LENGTH + round(travel * ratio)

        cross_start = (breadth - self.HANDLE_THICKNESS) / 2
        if vertical:
            return QRectF(cross_start, handle_start, self.HANDLE_THICKNESS, handle_length)
        return QRectF(handle_start, cross_start, handle_length, self.HANDLE_THICKNESS)

    def _accent_color(self) -> QColor:
        if self.isSliderDown():
            return QColor("#0a6fd6")
        if self.underMouse():
            return QColor("#5a5a66")
        return QColor("#494954")

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt method name
        del event

        if self.maximum() <= self.minimum():
            return

        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.fillRect(self.rect(), self._background)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(self._accent_color())

        handle_rect = self._handle_rect()
        radius = self.HANDLE_THICKNESS / 2
        painter.drawRoundedRect(handle_rect, radius, radius)

        center_x = self.width() / 2
        center_y = self.height() / 2
        arrow_width = 8
        arrow_height = 6

        if self.orientation() == Qt.Orientation.Vertical:
            painter.drawPolygon(
                QPolygonF(
                    [
                        QPointF(center_x, 4),
                        QPointF(center_x - (arrow_width / 2), 4 + arrow_height),
                        QPointF(center_x + (arrow_width / 2), 4 + arrow_height),
                    ]
                )
            )
            painter.drawPolygon(
                QPolygonF(
                    [
                        QPointF(center_x, self.height() - 4),
                        QPointF(center_x - (arrow_width / 2), self.height() - 4 - arrow_height),
                        QPointF(center_x + (arrow_width / 2), self.height() - 4 - arrow_height),
                    ]
                )
            )
        else:
            painter.drawPolygon(
                QPolygonF(
                    [
                        QPointF(4, center_y),
                        QPointF(4 + arrow_height, center_y - (arrow_width / 2)),
                        QPointF(4 + arrow_height, center_y + (arrow_width / 2)),
                    ]
                )
            )
            painter.drawPolygon(
                QPolygonF(
                    [
                        QPointF(self.width() - 4, center_y),
                        QPointF(self.width() - 4 - arrow_height, center_y - (arrow_width / 2)),
                        QPointF(self.width() - 4 - arrow_height, center_y + (arrow_width / 2)),
                    ]
                )
            )

        painter.end()


def install_polished_scrollbars(widget, background: str = "#202024") -> None:
    widget.setVerticalScrollBar(PolishedScrollBar(Qt.Orientation.Vertical, widget, background))
    widget.setHorizontalScrollBar(PolishedScrollBar(Qt.Orientation.Horizontal, widget, background))


class ConfirmationFlashOverlay(QWidget):
    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self._color: QColor | None = None
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.hide()

    def set_color(self, color: str) -> None:
        self._color = QColor(color)
        self.show()
        self.update()

    def clear_color(self) -> None:
        self._color = None
        self.hide()
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt method name
        del event

        if self._color is None:
            return

        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QPen(self._color, CONFIRMATION_FLASH_RING_WIDTH))
        painter.setBrush(Qt.BrushStyle.NoBrush)

        inset = CONFIRMATION_FLASH_RING_WIDTH / 2
        ring_rect = QRectF(self.rect()).adjusted(inset, inset, -inset, -inset)
        painter.drawRoundedRect(ring_rect, CONFIRMATION_FLASH_RING_RADIUS, CONFIRMATION_FLASH_RING_RADIUS)
        painter.end()


class GalleryDropOverlay(QWidget):
    def __init__(self, parent: QWidget) -> None:
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.hide()

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt method name
        del event

        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing)

        painter.fillRect(self.rect(), QColor(20, 20, 24, 140))

        border_rect = QRectF(self.rect()).adjusted(16, 16, -16, -16)
        painter.setBrush(QColor(10, 132, 255, 15))
        pen = QPen(QColor("#0a84ff"), 2)
        pen.setStyle(Qt.PenStyle.DashLine)
        pen.setDashPattern([6, 4])
        painter.setPen(pen)
        painter.drawRoundedRect(border_rect, 16, 16)

        center_x = self.width() / 2
        center_y = self.height() / 2

        glyph_pen = QPen(QColor("#0a84ff"), 2.4)
        glyph_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        glyph_pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(glyph_pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        top = center_y - 58
        painter.drawLine(QPointF(center_x, top), QPointF(center_x, top + 26))
        painter.drawPolyline(
            QPolygonF(
                [
                    QPointF(center_x - 9, top + 15),
                    QPointF(center_x, top + 26),
                    QPointF(center_x + 9, top + 15),
                ]
            )
        )
        painter.drawPolyline(
            QPolygonF(
                [
                    QPointF(center_x - 18, top + 22),
                    QPointF(center_x - 18, top + 34),
                    QPointF(center_x + 18, top + 34),
                    QPointF(center_x + 18, top + 22),
                ]
            )
        )

        title_font = QFont("Segoe UI", 13, QFont.Weight.DemiBold)
        painter.setFont(title_font)
        painter.setPen(QColor("#d8ebff"))
        title_rect = QRectF(0, center_y - 4, self.width(), 28)
        painter.drawText(title_rect, Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop, "Drop SVG files to add them")

        sub_font = QFont("Segoe UI", 10)
        painter.setFont(sub_font)
        painter.setPen(QColor("#76767f"))
        sub_rect = QRectF(0, center_y + 26, self.width(), 22)
        painter.drawText(sub_rect, Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop, "Non-SVG files are ignored")

        painter.end()


class FlashTextEdit(QTextEdit):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._confirmation_flash = ConfirmationFlashOverlay(self)
        self._confirmation_flash.setGeometry(self.rect())
        self._confirmation_flash_timers: list[QTimer] = []

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt method name
        super().resizeEvent(event)
        self._confirmation_flash.setGeometry(self.rect())
        self._confirmation_flash.raise_()

    def show_confirmation_flash(self, color: str) -> None:
        self._cancel_confirmation_flash()
        self._confirmation_flash.setGeometry(self.rect())
        self._confirmation_flash.raise_()
        self._confirmation_flash.set_color(CONFIRMATION_FLASH_DEFAULT_COLOR)

        for step in range(1, CONFIRMATION_FLASH_STEPS + 1):
            t = step / CONFIRMATION_FLASH_STEPS
            delay_ms = int(CONFIRMATION_FLASH_FADE_IN_MS * t)
            self._schedule_confirmation_flash_step(
                delay_ms,
                self._lerp_hex_color(CONFIRMATION_FLASH_DEFAULT_COLOR, color, t),
            )

        fade_out_start_ms = CONFIRMATION_FLASH_FADE_IN_MS + CONFIRMATION_FLASH_HOLD_MS
        for step in range(1, CONFIRMATION_FLASH_STEPS + 1):
            t = step / CONFIRMATION_FLASH_STEPS
            delay_ms = fade_out_start_ms + int(CONFIRMATION_FLASH_FADE_OUT_MS * t)
            self._schedule_confirmation_flash_step(
                delay_ms,
                self._lerp_hex_color(color, CONFIRMATION_FLASH_DEFAULT_COLOR, t),
                clear_after=(step == CONFIRMATION_FLASH_STEPS),
            )

    def _cancel_confirmation_flash(self) -> None:
        for timer in self._confirmation_flash_timers:
            timer.stop()
            timer.deleteLater()
        self._confirmation_flash_timers = []

    def _schedule_confirmation_flash_step(self, delay_ms: int, color: str, *, clear_after: bool = False) -> None:
        timer = QTimer(self)
        timer.setSingleShot(True)

        def run_step() -> None:
            if clear_after:
                self._confirmation_flash.clear_color()
            else:
                self._confirmation_flash.set_color(color)
            if timer in self._confirmation_flash_timers:
                self._confirmation_flash_timers.remove(timer)
            timer.deleteLater()

        timer.timeout.connect(run_step)
        self._confirmation_flash_timers.append(timer)
        timer.start(delay_ms)

    @staticmethod
    def _lerp_hex_color(start_color: str, end_color: str, t: float) -> str:
        start = QColor(start_color)
        end = QColor(end_color)
        return "#{:02x}{:02x}{:02x}".format(
            int(start.red() + (end.red() - start.red()) * t),
            int(start.green() + (end.green() - start.green()) * t),
            int(start.blue() + (end.blue() - start.blue()) * t),
        )


class LinkedIconsFile:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.newline = "\n"

    def _read_text(self) -> str:
        try:
            return self.path.read_text(encoding="utf-8", newline="")
        except FileNotFoundError as error:
            raise IconFormatError(f"{SOURCE_FILE_NAME} was not found beside IconEditor.pyw.") from error

    def split_file(self) -> tuple[str, str, str, str]:
        text = self._read_text()
        newline = detect_newline(text)

        open_match = TEMPLATE_OPEN_RE.search(text)
        if not open_match:
            raise IconFormatError('Could not find: const rawIconsData = `')

        body_start = open_match.end()
        body_end = text.find(CLOSING_BACKTICK_MARKER, body_start)
        if body_end == -1:
            raise IconFormatError("Could not find the protected closing backtick marker.")

        prefix = text[:body_start]
        body = text[body_start:body_end]
        suffix = text[body_end:]

        if SMART_ENGINE_MARKER not in suffix:
            raise IconFormatError('The "SMART INJECTION ENGINE" marker was not found after the icon list.')

        self.newline = newline
        return prefix, body, suffix, newline

    def load_icons(self) -> list[IconRecord]:
        _, body, _, _ = self.split_file()
        return self.parse_body(body)

    def load_editor_config(self) -> EditorConfig:
        _, _, suffix, _ = self.split_file()
        return parse_editor_config(suffix)

    def parse_body(self, body: str) -> list[IconRecord]:
        body_lf = to_lf(body)
        icons: list[IconRecord] = []

        if not body_lf.startswith("\n"):
            raise IconFormatError("rawIconsData must start with a newline before the first icon block.")

        if not body_lf.strip():
            return []

        position = 1
        separator = "\n\n\n\n"

        while position < len(body_lf):
            match = BLOCK_RE.match(body_lf, position)
            if not match:
                line = line_number_at(body_lf, position)
                raise IconFormatError(f"Icon block formatting does not match the required format near rawIconsData line {line}.")

            icons.append(IconRecord(match.group("name").strip(), match.group("svg").strip()))
            position = match.end()

            if body_lf.startswith(separator, position):
                position += len(separator)
                continue

            if position == len(body_lf):
                break

            line = line_number_at(body_lf, position)
            raise IconFormatError(f"Expected exactly three blank lines after the SVG near rawIconsData line {line}.")

        names = [icon.name for icon in icons]
        duplicate_names = sorted(name for name in set(names) if names.count(name) > 1)
        if duplicate_names:
            raise IconFormatError("Duplicate icon names found: " + ", ".join(duplicate_names))

        return icons

    def serialize_body(self, icons: list[IconRecord], newline: str) -> str:
        block_newline = "\n"
        separator = block_newline * 4
        blocks = []

        for icon in sorted_icons(icons):
            blocks.append(
                f"/*{block_newline}"
                f"{BAR}{block_newline}"
                f"{icon.name}{block_newline}"
                f"{BAR}{block_newline}"
                f"*/{block_newline}{block_newline}"
                f"\t{icon.svg}"
            )

        body_lf = block_newline + separator.join(blocks) + separator
        return body_lf.replace("\n", newline)

    def build_text(self, icons: list[IconRecord]) -> str:
        prefix, _, suffix, newline = self.split_file()
        return prefix + self.serialize_body(icons, newline) + suffix

    def save_icons(self, icons: list[IconRecord]) -> None:
        content = self.build_text(icons)
        # Write to a sibling temp file and atomically replace the target so a
        # failed or interrupted write can never leave linked_icons.js corrupted.
        temp_fd, temp_name = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        try:
            with open(temp_fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
            os.replace(temp_name, self.path)
        except OSError:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise


def load_editor_config_or_default(path: Path) -> EditorConfig:
    try:
        return LinkedIconsFile(path).load_editor_config()
    except IconFormatError:
        return EditorConfig()


class IconTile(QWidget):
    clicked = Signal()

    def __init__(
        self,
        icon: IconRecord,
        width: int,
        height: int,
        selected: bool = False,
        show_label: bool = True,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.icon_record = icon
        self.selected = selected
        self.show_label = show_label
        ok, _, normalized_svg = validate_svg_text(icon.svg)
        self._valid_svg = ok
        self._renderer: QSvgRenderer | None = None
        if ok:
            self._renderer = QSvgRenderer(QByteArray(preview_svg(normalized_svg, "#a1a1aa").encode("utf-8")))
        self._tile_width = width
        self._tile_height = height
        self._pressed = False
        self.setObjectName("IconTile")
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setFixedSize(width, height)
        self.setToolTip(icon.name)
        self.setAccessibleName(icon.name)

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt method name
        return QSize(self._tile_width, self._tile_height)

    def apply_metrics(self, width: int, height: int, show_label: bool) -> None:
        changed = (
            width != self._tile_width
            or height != self._tile_height
            or show_label != self.show_label
        )
        self._tile_width = width
        self._tile_height = height
        self.show_label = show_label
        if changed:
            self.setFixedSize(width, height)
            self.updateGeometry()
            self.update()

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt method name
        if event.button() == Qt.MouseButton.LeftButton:
            self._pressed = True
            self.update()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt method name
        if self._pressed and event.button() == Qt.MouseButton.LeftButton:
            self._pressed = False
            self.update()
            if self.rect().contains(event.position().toPoint()):
                self.clicked.emit()
                return
        self._pressed = False
        self.update()
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event) -> None:  # noqa: N802 - Qt method name
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space):
            self.clicked.emit()
            return
        super().keyPressEvent(event)

    def enterEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self.update()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self.update()
        super().leaveEvent(event)

    def focusInEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self.update()
        super().focusInEvent(event)

    def focusOutEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self.update()
        super().focusOutEvent(event)

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt method name
        del event

        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)

        hovered = self.underMouse()
        pressed = self._pressed
        focused = self.hasFocus()

        w = self.width()
        h = self.height()
        radius = max(7, min(18, round(w * 0.13)))

        card_rect = QRectF(0.75, 0.75, w - 1.5, h - 1.5)
        fill = QColor("#303036" if hovered else "#2b2b31")
        if self.selected:
            fill = QColor("#17314b" if hovered else "#13283f")
        if pressed:
            fill = QColor("#28282e")
            if self.selected:
                fill = QColor("#11243a")

        border = QColor("#5b5b65" if hovered or focused else "#3c3c44")
        if focused:
            border = QColor("#0a84ff")
        if self.selected:
            border = QColor("#0a84ff")

        painter.setPen(QPen(border, 1.7 if self.selected else 1.2))
        painter.setBrush(fill)
        painter.drawRoundedRect(card_rect, radius, radius)

        if hovered:
            painter.setPen(QPen(QColor(255, 255, 255, 18), 1))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRoundedRect(card_rect.adjusted(1.2, 1.2, -1.2, -1.2), radius - 1.5, radius - 1.5)

        pad_x = 0
        label_top = h
        label_height = 0
        if self.show_label:
            icon_side = round(w * 0.45)
            pad_x = max(6, round(w * 0.075))
            label_height = max(14, round(h * 0.17))
            bottom_pad = max(6, round(h * 0.085))
            label_top = h - bottom_pad - label_height
            icon_top = max(6, round((label_top - icon_side) / 2))
        else:
            icon_side = round(w * 0.48)
            icon_top = round((h - icon_side) / 2)

        if pressed:
            icon_top += 1
        icon_rect = QRectF((w - icon_side) / 2, icon_top, icon_side, icon_side)

        if self._valid_svg and self._renderer is not None and self._renderer.isValid():
            self._renderer.render(painter, icon_rect)
        else:
            badge_side = min(
                icon_side * 1.14,
                w - 14,
                (label_top if self.show_label else h) - 12,
            )
            badge_rect = QRectF(
                (w - badge_side) / 2,
                icon_rect.center().y() - (badge_side / 2),
                badge_side,
                badge_side,
            )
            if badge_rect.top() < 6:
                badge_rect.moveTop(6)
            badge_bottom = (label_top - 6) if self.show_label else (h - 6)
            if badge_rect.bottom() > badge_bottom:
                badge_rect.moveBottom(badge_bottom)
            badge_radius = max(7, round(badge_side * 0.14))
            painter.setPen(QPen(QColor("#ff6b61"), max(1.4, icon_side * 0.045)))
            painter.setBrush(QColor("#3a2024"))
            painter.drawRoundedRect(badge_rect, badge_radius, badge_radius)

            center = badge_rect.center()
            triangle_width = badge_side * 0.72
            triangle_height = badge_side * 0.66
            triangle = QPolygonF(
                [
                    QPointF(center.x(), center.y() - triangle_height * 0.50),
                    QPointF(center.x() + triangle_width * 0.50, center.y() + triangle_height * 0.42),
                    QPointF(center.x() - triangle_width * 0.50, center.y() + triangle_height * 0.42),
                ]
            )
            painter.setPen(QPen(QColor("#ff6b61"), max(1.3, badge_side * 0.035)))
            painter.setBrush(QColor("#ffb13b"))
            painter.drawPolygon(triangle)

            mark_color = QColor("#391416")
            stem_width = max(3.0, badge_side * 0.09)
            stem_height = triangle_height * 0.34
            stem_rect = QRectF(
                center.x() - stem_width / 2,
                center.y() - triangle_height * 0.18,
                stem_width,
                stem_height,
            )
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(mark_color)
            painter.drawRoundedRect(stem_rect, stem_width / 2, stem_width / 2)
            dot_size = stem_width * 1.18
            painter.drawEllipse(
                QRectF(
                    center.x() - dot_size / 2,
                    center.y() + triangle_height * 0.25,
                    dot_size,
                    dot_size,
                )
            )

        if self.show_label:
            label_font = QFont("Segoe UI")
            label_font.setPointSize(10 if w >= 132 else 9)
            label_font.setWeight(QFont.Weight.Medium)
            metrics = QFontMetrics(label_font)
            painter.setFont(label_font)
            label_rect = QRectF(pad_x, label_top, w - 2 * pad_x, label_height)
            if pressed:
                label_rect.translate(0, 1)
            label = display_name(self.icon_record.name or "untitled", round(label_rect.width()), metrics)
            painter.setPen(QColor("#b7b7c0" if hovered else "#96969f"))
            if self.selected:
                painter.setPen(QColor("#d8ebff"))
            painter.drawText(label_rect, Qt.AlignmentFlag.AlignCenter, label)

        painter.end()


class IconEditorDialog(QDialog):
    def __init__(
        self,
        parent: QWidget,
        icon: IconRecord,
        reserved_names: set[str],
        is_new: bool,
    ) -> None:
        super().__init__(parent)
        self.reserved_names = reserved_names
        self.is_new = is_new
        self.result_icon: IconRecord | None = None
        self.delete_requested = False
        self._normalizing_name = False

        self.setObjectName("EditorDialog")
        self.setWindowTitle("Add icon" if is_new else f"Edit {icon.name}")
        self.resize(1060, 730)
        self.setModal(True)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        header = QFrame()
        header.setObjectName("DialogHeader")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(24, 18, 18, 14)
        header_layout.setSpacing(14)

        self.title_label = QLabel("Add new SVG icon" if is_new else f"Edit {icon.name}")
        self.title_label.setObjectName("DialogTitle")
        header_layout.addWidget(self.title_label, 1)

        close_button = QPushButton("x")
        close_button.setObjectName("CloseButton")
        close_button.setFixedSize(36, 36)
        close_button.clicked.connect(self.reject)
        header_layout.addWidget(close_button, 0)
        root.addWidget(header)

        upper = QFrame()
        upper.setObjectName("DialogUpper")
        upper_layout = QHBoxLayout(upper)
        upper_layout.setContentsMargins(24, 18, 24, 18)
        upper_layout.setSpacing(18)

        preview_card = QFrame()
        preview_card.setObjectName("PreviewCard")
        preview_layout = QVBoxLayout(preview_card)
        preview_layout.setContentsMargins(18, 18, 18, 18)
        preview_layout.setSpacing(8)
        self.preview_label = QLabel()
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setMinimumHeight(154)
        preview_layout.addWidget(self.preview_label, 1)
        upper_layout.addWidget(preview_card, 5)

        name_card = QFrame()
        name_card.setObjectName("NameCard")
        name_layout = QVBoxLayout(name_card)
        name_layout.setContentsMargins(18, 18, 18, 18)
        name_layout.setSpacing(10)

        name_label = QLabel("ICON NAME")
        name_label.setObjectName("FieldLabel")
        name_layout.addWidget(name_label)

        self.name_input = QLineEdit()
        self.name_input.setObjectName("NameInput")
        self.name_input.setPlaceholderText("icon-name")
        self.name_input.setText(icon.name)
        self.name_input.textEdited.connect(self._normalize_name_input)
        self.name_input.textChanged.connect(self._sync_title)
        name_layout.addWidget(self.name_input)

        hint = QLabel(
            "Names are written as the comment-block heading in linked_icons.js. "
            "Uppercase, spaces, underscores, and symbols are normalized to lowercase kebab-case."
        )
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        name_layout.addWidget(hint)
        upper_layout.addWidget(name_card, 7)
        root.addWidget(upper)

        code_area = QFrame()
        code_area.setObjectName("CodeArea")
        code_layout = QVBoxLayout(code_area)
        code_layout.setContentsMargins(24, 0, 24, 18)
        code_layout.setSpacing(6)

        code_label = QLabel("SVG CODE")
        code_label.setObjectName("FieldLabel")
        code_layout.addWidget(code_label)

        self.svg_input = QTextEdit()
        self.svg_input.setObjectName("SvgInput")
        self.svg_input.setAcceptRichText(False)
        self.svg_input.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)
        install_polished_scrollbars(self.svg_input, "#18181c")
        self.svg_input.setPlainText(icon.svg)
        mono = QFont("Cascadia Mono")
        if not mono.exactMatch():
            mono = QFont("Consolas")
        mono.setPointSize(10)
        self.svg_input.setFont(mono)
        self.svg_input.textChanged.connect(self._update_preview)
        code_layout.addWidget(self.svg_input, 1)

        self.message_label = QLabel("")
        self.message_label.setObjectName("ValidationMessage")
        self.message_label.setWordWrap(True)
        code_layout.addWidget(self.message_label)
        root.addWidget(code_area, 1)

        footer = QFrame()
        footer.setObjectName("DialogFooter")
        footer_layout = QHBoxLayout(footer)
        footer_layout.setContentsMargins(24, 16, 24, 18)
        footer_layout.setSpacing(10)

        self.delete_button = QPushButton("Delete icon")
        self.delete_button.setObjectName("DangerButton")
        self.delete_button.setProperty("variant", "danger")
        self.delete_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.delete_button.setVisible(not is_new)
        self.delete_button.clicked.connect(self._request_delete)
        footer_layout.addWidget(self.delete_button, 0)
        footer_layout.addStretch(1)

        copy_button = QPushButton("Copy SVG")
        copy_button.setObjectName("SecondaryButton")
        copy_button.setCursor(Qt.CursorShape.PointingHandCursor)
        copy_button.clicked.connect(self._copy_svg)
        footer_layout.addWidget(copy_button, 0)

        cancel_button = QPushButton("Cancel")
        cancel_button.setObjectName("SecondaryButton")
        cancel_button.setCursor(Qt.CursorShape.PointingHandCursor)
        cancel_button.clicked.connect(self.reject)
        footer_layout.addWidget(cancel_button, 0)

        save_button = QPushButton("Save to gallery")
        save_button.setObjectName("PrimaryButton")
        save_button.setCursor(Qt.CursorShape.PointingHandCursor)
        save_button.clicked.connect(self._save_icon)
        footer_layout.addWidget(save_button, 0)

        root.addWidget(footer)
        self._update_preview()

    def _normalize_name_input(self, text: str) -> None:
        if self._normalizing_name:
            return

        normalized = normalize_name_live(text)
        if normalized == text:
            return

        cursor_position = self.name_input.cursorPosition()
        normalized_prefix = normalize_name_live(text[:cursor_position])

        self._normalizing_name = True
        self.name_input.setText(normalized)
        self.name_input.setCursorPosition(len(normalized_prefix))
        self._normalizing_name = False

    def _sync_title(self) -> None:
        name = normalize_name_final(self.name_input.text()) or "new-icon"
        self.title_label.setText("Add new SVG icon" if self.is_new else f"Edit {name}")

    def _set_message(self, text: str, kind: str = "muted") -> None:
        self.message_label.setText(text)
        self.message_label.setProperty("kind", kind)
        repolish(self.message_label)

    def _update_preview(self) -> None:
        svg = normalize_svg_line(self.svg_input.toPlainText())
        if svg:
            self.preview_label.setPixmap(render_svg_pixmap(svg, 118, "#a5a5ad"))
        else:
            self.preview_label.clear()

    def _copy_svg(self) -> None:
        QGuiApplication.clipboard().setText(self.svg_input.toPlainText())
        self._set_message("SVG copied to clipboard.", "success")

    def _request_delete(self) -> None:
        name = normalize_name_final(self.name_input.text()) or "this icon"
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("Delete icon")
        box.setText(f'Delete "{name}" from the gallery?')
        box.setInformativeText("The change is not written to linked_icons.js until you click Save linked_icons.js.")
        delete_button = box.addButton("Delete icon", QMessageBox.ButtonRole.DestructiveRole)
        box.addButton(QMessageBox.StandardButton.Cancel)
        box.exec()

        if box.clickedButton() == delete_button:
            self.delete_requested = True
            self.accept()

    def _save_icon(self) -> None:
        name = normalize_name_final(self.name_input.text())
        if name != self.name_input.text():
            self.name_input.setText(name)

        if not name:
            self._set_message("Icon name cannot be empty.", "error")
            self.name_input.setFocus()
            return

        if not NAME_RE.fullmatch(name):
            self._set_message("Icon name must be lowercase kebab-case, for example icon-one.", "error")
            self.name_input.setFocus()
            return

        if name in self.reserved_names:
            self._set_message(f'The icon name "{name}" already exists.', "error")
            self.name_input.setFocus()
            return

        ok, message, normalized_svg = validate_svg_text(self.svg_input.toPlainText())
        if not ok:
            self._set_message(message, "error")
            self.svg_input.setFocus()
            return

        self.result_icon = IconRecord(name, normalized_svg)
        self.accept()


class ZoomStepButton(QPushButton):
    """A small circular +/- button whose glyph is painted for pixel-perfect centering.

    Text glyphs ("+"/"−") never sit exactly on the optical center of a circle
    because of font side-bearings and baseline metrics. Painting the glyph
    ourselves keeps it dead-centered at any size and DPI.
    """

    def __init__(self, kind: str, diameter: int = 24, parent=None) -> None:
        super().__init__(parent)
        self._kind = kind  # "plus" or "minus"
        self._diameter = diameter
        self._hovered = False
        self.setFixedSize(diameter, diameter)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def enterEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self._hovered = True
        self.update()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self._hovered = False
        self.update()
        super().leaveEvent(event)

    def _palette(self) -> tuple[QColor, QColor, QColor]:
        # Returns (fill, border, glyph) for the current state.
        if not self.isEnabled():
            return QColor("#232328"), QColor("#2f2f36"), QColor("#4f4f57")
        if self.isDown():
            return QColor("#233a50"), QColor("#0a84ff"), QColor("#e3f1ff")
        if self._hovered:
            return QColor("#33333a"), QColor("#5b5b66"), QColor("#f0f0f4")
        return QColor("#282830"), QColor("#3d3d46"), QColor("#c2c2cc")

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt method name
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        fill, border, glyph = self._palette()
        d = self._diameter
        inset = 1.0
        circle = QRectF(inset, inset, d - inset * 2, d - inset * 2)

        painter.setPen(QPen(border, 1.0))
        painter.setBrush(fill)
        painter.drawEllipse(circle)

        # Glyph geometry, centered on the circle.
        cx, cy = d / 2.0, d / 2.0
        arm = d * 0.26          # half-length of each stroke
        thickness = max(1.6, d * 0.083)
        radius = thickness / 2.0

        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(glyph)
        # Horizontal stroke (shared by + and −).
        painter.drawRoundedRect(
            QRectF(cx - arm, cy - thickness / 2.0, arm * 2, thickness),
            radius,
            radius,
        )
        if self._kind == "plus":
            painter.drawRoundedRect(
                QRectF(cx - thickness / 2.0, cy - arm, thickness, arm * 2),
                radius,
                radius,
            )
        painter.end()


class ZoomSlider(QSlider):
    doubleClicked = Signal()

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802 - Qt method name
        if event.button() == Qt.MouseButton.LeftButton:
            self.doubleClicked.emit()
            event.accept()
            return
        super().mouseDoubleClickEvent(event)


class MainWindow(QMainWindow):
    def __init__(
        self,
        editor_config: EditorConfig | None = None,
        icon_file: LinkedIconsFile | None = None,
    ) -> None:
        super().__init__()
        self.source_path = Path(__file__).resolve().with_name(SOURCE_FILE_NAME)
        self.icon_file = icon_file if icon_file is not None else LinkedIconsFile(self.source_path)
        self.editor_config = editor_config if editor_config is not None else load_editor_config_or_default(self.source_path)
        self.icons: list[IconRecord] = []
        self.saved_icons: list[IconRecord] = []
        self.icon_histories: dict[int, IconHistory] = {}
        self.selected_uid: int | None = None
        self.dirty = False
        self._updating_editor = False
        self._normalizing_main_name = False
        self._history_edit_uid: int | None = None
        self._history_edit_field: str | None = None
        self._history_edit_group: int | None = None
        self._history_group_counter = itertools.count(1)
        self._pending_history_cursor: tuple[int, str, int, int] | None = None
        self._last_export_dir = self.source_path.parent
        self._last_grid_signature = (0, 0, 0, 0, 0, 0)
        self.tile_size = TILE_DEFAULT_SIZE
        self._tiles: list[IconTile] = []
        self._resize_timer = QTimer(self)
        self._resize_timer.setSingleShot(True)
        self._resize_timer.timeout.connect(self._reflow_grid)
        self._edit_refresh_timer = QTimer(self)
        self._edit_refresh_timer.setSingleShot(True)
        self._edit_refresh_timer.timeout.connect(self.render_grid)
        self._history_coalesce_timer = QTimer(self)
        self._history_coalesce_timer.setSingleShot(True)
        self._history_coalesce_timer.timeout.connect(self.finish_history_edit)

        self.setObjectName("MainWindow")
        self.setWindowTitle(self.editor_config.app_title)
        self.resize(1520, 900)
        self.setMinimumSize(MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT)

        self._build_ui()
        self._setup_zoom_shortcuts()
        self._setup_history_shortcuts()
        self._load_icons()
        self.centralWidget().setFocus(Qt.FocusReason.OtherFocusReason)

    def _build_ui(self) -> None:
        central = QWidget()
        central.setObjectName("Root")
        central.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        root_layout = QVBoxLayout(central)
        root_layout.setContentsMargins(28, 22, 28, 26)
        root_layout.setSpacing(16)
        self.setCentralWidget(central)

        topbar = QFrame()
        topbar.setObjectName("TopBar")
        top_layout = QHBoxLayout(topbar)
        top_layout.setContentsMargins(0, 0, 0, 4)
        top_layout.setSpacing(18)

        gallery_toolbar = QWidget()
        gallery_toolbar.setObjectName("GalleryToolbar")
        gallery_toolbar_layout = QHBoxLayout(gallery_toolbar)
        gallery_toolbar_layout.setContentsMargins(0, 0, 0, 0)
        gallery_toolbar_layout.setSpacing(14)

        app_icon_label = QLabel()
        app_icon_label.setObjectName("HeaderAppIcon")
        app_icon_label.setFixedSize(38, 38)
        app_icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        header_icon = build_svg_icon(self.editor_config.header_icon_svg)
        if header_icon.isNull():
            header_icon = build_app_icon()
        app_icon_label.setPixmap(header_icon.pixmap(QSize(38, 38)))
        app_icon_label.setToolTip(self.editor_config.app_title)
        gallery_toolbar_layout.addWidget(app_icon_label, 0, Qt.AlignmentFlag.AlignVCenter)

        title_group = QVBoxLayout()
        title_group.setSpacing(3)
        title = QLabel(self.editor_config.gallery_header)
        title.setObjectName("Title")
        title_group.addWidget(title)
        self.meta_label = QLabel("0 / 0 SVGs from linked_icons.js")
        self.meta_label.setObjectName("Meta")
        title_group.addWidget(self.meta_label)
        gallery_toolbar_layout.addLayout(title_group, 1)

        self.search_input = QLineEdit()
        self.search_input.setObjectName("SearchInput")
        self.search_input.setPlaceholderText("Search SVG names...")
        self.search_input.setClearButtonEnabled(True)
        self.search_input.setMinimumWidth(220)
        self.search_input.setMaximumWidth(690)
        self.search_input.textChanged.connect(self.render_grid)
        gallery_toolbar_layout.addWidget(self.search_input, 0, Qt.AlignmentFlag.AlignRight)

        self.zoom_controls = QWidget()
        self.zoom_controls.setObjectName("ZoomControls")
        zoom_layout = QHBoxLayout(self.zoom_controls)
        zoom_layout.setContentsMargins(0, 0, 0, 0)
        zoom_layout.setSpacing(10)

        self.zoom_out_button = ZoomStepButton("minus")
        self.zoom_out_button.setObjectName("ZoomButton")
        self.zoom_out_button.setAutoRepeat(True)
        self.zoom_out_button.setAutoRepeatDelay(320)
        self.zoom_out_button.setAutoRepeatInterval(55)
        self.zoom_out_button.setToolTip("Smaller icons  (Ctrl−)")
        self.zoom_out_button.clicked.connect(lambda: self.adjust_tile_size(-TILE_ZOOM_STEP))
        zoom_layout.addWidget(self.zoom_out_button)

        self.zoom_slider = ZoomSlider(Qt.Orientation.Horizontal)
        self.zoom_slider.setObjectName("ZoomSlider")
        self.zoom_slider.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.zoom_slider.setMinimum(TILE_ZOOM_MIN)
        self.zoom_slider.setMaximum(TILE_ZOOM_MAX)
        self.zoom_slider.setSingleStep(2)
        self.zoom_slider.setPageStep(TILE_ZOOM_STEP)
        self.zoom_slider.setValue(self.tile_size)
        self.zoom_slider.setFixedWidth(132)
        self.zoom_slider.valueChanged.connect(self._on_zoom_slider)
        self.zoom_slider.doubleClicked.connect(self.reset_tile_size)
        zoom_layout.addWidget(self.zoom_slider)

        self.zoom_in_button = ZoomStepButton("plus")
        self.zoom_in_button.setObjectName("ZoomButton")
        self.zoom_in_button.setAutoRepeat(True)
        self.zoom_in_button.setAutoRepeatDelay(320)
        self.zoom_in_button.setAutoRepeatInterval(55)
        self.zoom_in_button.setToolTip("Larger icons  (Ctrl+)")
        self.zoom_in_button.clicked.connect(lambda: self.adjust_tile_size(TILE_ZOOM_STEP))
        zoom_layout.addWidget(self.zoom_in_button)

        gallery_toolbar_layout.addWidget(self.zoom_controls, 0, Qt.AlignmentFlag.AlignRight)
        self._update_zoom_ui()
        top_layout.addWidget(gallery_toolbar, 1)

        actions_toolbar = QWidget()
        actions_toolbar.setObjectName("ActionsToolbar")
        actions_toolbar.setFixedWidth(EDITOR_PANEL_WIDTH)
        actions_toolbar_layout = QHBoxLayout(actions_toolbar)
        actions_toolbar_layout.setContentsMargins(0, 0, 0, 0)
        actions_toolbar_layout.setSpacing(10)
        actions_toolbar_layout.addStretch(1)

        self.save_button = QPushButton("Save linked_icons.js")
        self.save_button.setObjectName("SaveButton")
        self.save_button.setProperty("toolbar", "true")
        self.save_button.setMinimumWidth(160)
        self.save_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.save_button.clicked.connect(self.save_file)
        actions_toolbar_layout.addWidget(self.save_button, 0)
        top_layout.addWidget(actions_toolbar, 0)
        root_layout.addWidget(topbar)

        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(18)
        root_layout.addLayout(body, 1)

        gallery_panel = QFrame()
        gallery_panel.setObjectName("GalleryPanel")
        self.gallery_panel = gallery_panel
        gallery_layout = QVBoxLayout(gallery_panel)
        gallery_layout.setContentsMargins(0, 0, 0, 0)
        gallery_layout.setSpacing(0)

        self.scroll_area = QScrollArea()
        self.scroll_area.setObjectName("GalleryScroll")
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setFrameShape(QFrame.Shape.NoFrame)
        install_polished_scrollbars(self.scroll_area)
        self.scroll_area.viewport().installEventFilter(self)

        self.gallery_widget = QWidget()
        self.gallery_widget.setObjectName("Gallery")
        self.grid_layout = QGridLayout(self.gallery_widget)
        self.grid_layout.setContentsMargins(0, 0, 0, 8)
        self.grid_layout.setHorizontalSpacing(12)
        self.grid_layout.setVerticalSpacing(14)
        self.grid_layout.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)

        self.scroll_area.setWidget(self.gallery_widget)
        gallery_layout.addWidget(self.scroll_area, 1)

        gallery_footer = QFrame()
        gallery_footer.setObjectName("GalleryFooter")
        gallery_footer_layout = QHBoxLayout(gallery_footer)
        gallery_footer_layout.setContentsMargins(0, 12, 0, 0)
        gallery_footer_layout.setSpacing(10)

        self.add_button = QPushButton("Add icon")
        self.add_button.setObjectName("SecondaryButton")
        self.add_button.setProperty("toolbar", "true")
        self.add_button.setMinimumWidth(92)
        self.add_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.add_button.clicked.connect(self.add_icon)
        gallery_footer_layout.addWidget(self.add_button, 0)

        self.delete_button = QPushButton("Delete")
        self.delete_button.setObjectName("DangerButton")
        self.delete_button.setProperty("toolbar", "true")
        self.delete_button.setMinimumWidth(76)
        self.delete_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.delete_button.clicked.connect(self.delete_selected_icon)
        gallery_footer_layout.addWidget(self.delete_button, 0)

        gallery_footer_layout.addStretch(1)
        gallery_layout.addWidget(gallery_footer, 0)
        body.addWidget(gallery_panel, 1)

        self.editor_panel = QFrame()
        self.editor_panel.setObjectName("EditorPanel")
        self.editor_panel.setFixedWidth(EDITOR_PANEL_WIDTH)
        editor_layout = QVBoxLayout(self.editor_panel)
        editor_layout.setContentsMargins(20, 20, 20, 20)
        editor_layout.setSpacing(12)

        preview_header = QWidget()
        preview_header.setObjectName("EditorHistoryHeader")
        preview_header_layout = QHBoxLayout(preview_header)
        preview_header_layout.setContentsMargins(0, 0, 0, 0)
        preview_header_layout.setSpacing(8)

        preview_title = QLabel("SELECTED ICON")
        preview_title.setObjectName("PanelLabel")
        preview_header_layout.addWidget(preview_title, 0, Qt.AlignmentFlag.AlignVCenter)
        preview_header_layout.addStretch(1)

        self.undo_button = QPushButton("Undo")
        self.undo_button.setObjectName("HistoryButton")
        self.undo_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.undo_button.setToolTip("Undo the last edit to the selected icon  (Ctrl+Z)")
        self.undo_button.clicked.connect(self.undo_selected_icon)
        preview_header_layout.addWidget(self.undo_button, 0, Qt.AlignmentFlag.AlignVCenter)

        self.redo_button = QPushButton("Redo")
        self.redo_button.setObjectName("HistoryButton")
        self.redo_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.redo_button.setToolTip("Redo the last edit to the selected icon  (Ctrl+Y or Ctrl+Shift+Z)")
        self.redo_button.clicked.connect(self.redo_selected_icon)
        preview_header_layout.addWidget(self.redo_button, 0, Qt.AlignmentFlag.AlignVCenter)

        editor_layout.addWidget(preview_header)

        preview_card = QFrame()
        preview_card.setObjectName("EditorPreviewCard")
        preview_layout = QVBoxLayout(preview_card)
        preview_layout.setContentsMargins(18, 18, 18, 18)
        self.editor_preview = QLabel()
        self.editor_preview.setObjectName("EditorPreview")
        self.editor_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.editor_preview.setMinimumHeight(154)
        preview_layout.addWidget(self.editor_preview, 1)
        editor_layout.addWidget(preview_card, 0)

        name_label = QLabel("ICON LABEL")
        name_label.setObjectName("PanelLabel")
        editor_layout.addWidget(name_label)

        self.editor_name_input = QLineEdit()
        self.editor_name_input.setObjectName("EditorNameInput")
        self.editor_name_input.setPlaceholderText("icon-name")
        self.editor_name_input.textEdited.connect(self.on_editor_name_edited)
        self.editor_name_input.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.editor_name_input.customContextMenuRequested.connect(
            lambda position: self.show_editor_context_menu(self.editor_name_input, position)
        )
        self.editor_name_input.installEventFilter(self)
        editor_layout.addWidget(self.editor_name_input)

        svg_label = QLabel("SVG CODE")
        svg_label.setObjectName("PanelLabel")
        editor_layout.addWidget(svg_label)

        self.editor_svg_input = FlashTextEdit()
        self.editor_svg_input.setObjectName("EditorSvgInput")
        self.editor_svg_input.setAcceptRichText(False)
        self.editor_svg_input.setUndoRedoEnabled(False)
        self.editor_svg_input.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)
        install_polished_scrollbars(self.editor_svg_input, "#18181d")
        mono = QFont("Cascadia Mono")
        if not mono.exactMatch():
            mono = QFont("Consolas")
        mono.setPointSize(10)
        self.editor_svg_input.setFont(mono)
        self.editor_svg_input.textChanged.connect(self.on_editor_svg_changed)
        self.editor_svg_input.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.editor_svg_input.customContextMenuRequested.connect(
            lambda position: self.show_editor_context_menu(self.editor_svg_input, position)
        )
        self.editor_svg_input.installEventFilter(self)
        editor_layout.addWidget(self.editor_svg_input, 1)

        editor_tools = QFrame()
        editor_tools.setObjectName("EditorToolBar")
        editor_tools_layout = QHBoxLayout(editor_tools)
        editor_tools_layout.setContentsMargins(0, 0, 0, 0)
        editor_tools_layout.setSpacing(8)

        self.editor_clear_button = QPushButton("Clear")
        self.editor_clear_button.setObjectName("EditorToolButton")
        self.editor_clear_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.editor_clear_button.setToolTip("Clear the SVG code for the selected icon.")
        self.editor_clear_button.clicked.connect(self.clear_editor_svg)
        editor_tools_layout.addWidget(self.editor_clear_button, 0)

        self.editor_paste_button = QPushButton("Paste")
        self.editor_paste_button.setObjectName("EditorToolButton")
        self.editor_paste_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.editor_paste_button.setToolTip("Replace the SVG code with the current clipboard text.")
        self.editor_paste_button.clicked.connect(self.paste_editor_svg)
        editor_tools_layout.addWidget(self.editor_paste_button, 0)

        editor_tools_layout.addStretch(1)

        self.editor_copy_button = QPushButton("Copy SVG Code")
        self.editor_copy_button.setObjectName("EditorToolButton")
        self.editor_copy_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.editor_copy_button.setToolTip("Copy the selected icon's SVG code.")
        self.editor_copy_button.clicked.connect(self.copy_editor_svg)
        editor_tools_layout.addWidget(self.editor_copy_button, 0)

        self.editor_export_button = QPushButton("Export .svg")
        self.editor_export_button.setObjectName("EditorToolButton")
        self.editor_export_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.editor_export_button.setToolTip("Export the selected icon as an SVG file.")
        self.editor_export_button.clicked.connect(self.export_selected_svg)
        editor_tools_layout.addWidget(self.editor_export_button, 0)

        editor_layout.addWidget(editor_tools)

        body.addWidget(self.editor_panel, 0)

        self.drop_overlay = GalleryDropOverlay(self.gallery_panel)
        self._position_drop_overlay()
        self.setAcceptDrops(True)

        self.set_dirty(False)

    def _load_icons(self) -> None:
        try:
            self.icons = self.icon_file.load_icons()
            self.saved_icons = copy.deepcopy(self.icons)
            self.icon_histories = {icon.uid: IconHistory.for_icon(icon) for icon in self.icons}
            self.selected_uid = self.icons[0].uid if self.icons else None
        except IconFormatError as error:
            self.icons = []
            self.saved_icons = []
            self.icon_histories = {}
            self.selected_uid = None
            QMessageBox.critical(self, "Could not load linked_icons.js", str(error))

        self.set_dirty(False)
        self.update_editor_from_selection()
        self.render_grid()

    def set_dirty(self, value: bool) -> None:
        self.dirty = value
        self.save_button.setEnabled(value)
        self.save_button.setProperty("dirty", "true" if value else "false")
        repolish(self.save_button)
        title = self.editor_config.app_title + (" *" if value else "")
        self.setWindowTitle(title)

    def selected_index(self) -> int | None:
        if self.selected_uid is None:
            return None
        for index, icon in enumerate(self.icons):
            if icon.uid == self.selected_uid:
                return index
        self.selected_uid = None
        return None

    def selected_icon(self) -> IconRecord | None:
        index = self.selected_index()
        return self.icons[index] if index is not None else None

    def update_buttons(self) -> None:
        has_selection = self.selected_index() is not None
        self.delete_button.setEnabled(has_selection)
        self.editor_name_input.setEnabled(has_selection)
        self.editor_svg_input.setEnabled(has_selection)
        history = self.icon_histories.get(self.selected_uid) if self.selected_uid is not None else None
        self.undo_button.setEnabled(bool(history and history.can_undo))
        self.redo_button.setEnabled(bool(history and history.can_redo))
        for button in (
            self.editor_clear_button,
            self.editor_paste_button,
            self.editor_copy_button,
            self.editor_export_button,
        ):
            button.setEnabled(has_selection)

    def finish_history_edit(self) -> None:
        self._history_coalesce_timer.stop()
        self._history_edit_uid = None
        self._history_edit_field = None
        self._history_edit_group = None
        self._pending_history_cursor = None

    def _editor_cursor_state(self, edit_field: str) -> tuple[int, int]:
        if edit_field == "name":
            cursor_position = self.editor_name_input.cursorPosition()
            selection_start = self.editor_name_input.selectionStart()
            if selection_start < 0:
                return cursor_position, cursor_position
            selection_end = selection_start + len(self.editor_name_input.selectedText())
            anchor_position = selection_end if cursor_position == selection_start else selection_start
            return cursor_position, anchor_position

        cursor = self.editor_svg_input.textCursor()
        return cursor.position(), cursor.anchor()

    def _capture_history_cursor(self, widget: QLineEdit | QTextEdit) -> None:
        icon = self.selected_icon()
        if icon is None:
            self._pending_history_cursor = None
            return
        edit_field = "name" if widget is self.editor_name_input else "svg"
        cursor_position, anchor_position = self._editor_cursor_state(edit_field)
        self._pending_history_cursor = (
            icon.uid,
            edit_field,
            cursor_position,
            anchor_position,
        )

    def _take_history_cursor_before(
        self,
        icon: IconRecord,
        edit_field: str,
        fallback: tuple[int, int],
    ) -> tuple[int, int]:
        pending = self._pending_history_cursor
        self._pending_history_cursor = None
        if pending is not None and pending[0] == icon.uid and pending[1] == edit_field:
            return pending[2], pending[3]
        return fallback

    def _record_icon_history(
        self,
        old_icon: IconRecord,
        new_icon: IconRecord,
        edit_field: str,
    ) -> None:
        history = self.icon_histories.get(new_icon.uid)
        if history is None:
            history = IconHistory.for_icon(old_icon)
            self.icon_histories[new_icon.uid] = history
        elif history.current.name != old_icon.name or history.current.svg != old_icon.svg:
            # Keep the history usable if a future non-editor code path changes an icon.
            history.reconcile_current(old_icon)

        cursor_position, anchor_position = self._editor_cursor_state(edit_field)
        before_cursor_position, before_anchor_position = self._take_history_cursor_before(
            old_icon,
            edit_field,
            (cursor_position, anchor_position),
        )
        same_group = (
            self._history_coalesce_timer.isActive()
            and self._history_edit_uid == new_icon.uid
            and self._history_edit_field == edit_field
            and self._history_edit_group is not None
        )
        if not same_group:
            self.finish_history_edit()
            self._history_edit_uid = new_icon.uid
            self._history_edit_field = edit_field
            self._history_edit_group = next(self._history_group_counter)

        history.record(
            new_icon,
            edit_field=edit_field,
            cursor_position=cursor_position,
            anchor_position=anchor_position,
            before_cursor_position=before_cursor_position,
            before_anchor_position=before_anchor_position,
            edit_group=self._history_edit_group,
        )
        self._history_coalesce_timer.start(ICON_HISTORY_COALESCE_MS)
        self.update_buttons()

    def undo_selected_icon(self) -> None:
        self.finish_history_edit()
        icon = self.selected_icon()
        history = self.icon_histories.get(icon.uid) if icon is not None else None
        restore = history.undo() if history is not None else None
        if icon is None or restore is None:
            self.update_buttons()
            return
        self._apply_history_restore(icon.uid, restore)

    def redo_selected_icon(self) -> None:
        self.finish_history_edit()
        icon = self.selected_icon()
        history = self.icon_histories.get(icon.uid) if icon is not None else None
        restore = history.redo() if history is not None else None
        if icon is None or restore is None:
            self.update_buttons()
            return
        self._apply_history_restore(icon.uid, restore)

    def _apply_history_restore(self, uid: int, restore: IconHistoryRestore) -> None:
        index = next((i for i, icon in enumerate(self.icons) if icon.uid == uid), None)
        if index is None:
            return

        self._edit_refresh_timer.stop()
        self.icons[index] = IconRecord(restore.name, restore.svg, uid)
        self.icons = sorted_icons(self.icons)
        self.selected_uid = uid
        self.set_dirty(self.icons != self.saved_icons)
        self.update_editor_from_selection()
        self.render_grid()
        self._restore_editor_cursor(
            restore.edit_field,
            restore.cursor_position,
            restore.anchor_position,
        )

    def _restore_editor_cursor(
        self,
        edit_field: str | None,
        cursor_position: int,
        anchor_position: int,
    ) -> None:
        if edit_field == "name":
            text_length = len(self.editor_name_input.text())
            cursor_position = max(0, min(cursor_position, text_length))
            anchor_position = max(0, min(anchor_position, text_length))
            self.editor_name_input.setFocus(Qt.FocusReason.ShortcutFocusReason)
            if cursor_position == anchor_position:
                self.editor_name_input.setCursorPosition(cursor_position)
            else:
                self.editor_name_input.setSelection(
                    anchor_position,
                    cursor_position - anchor_position,
                )
        elif edit_field == "svg":
            text_length = len(self.editor_svg_input.toPlainText())
            cursor_position = max(0, min(cursor_position, text_length))
            anchor_position = max(0, min(anchor_position, text_length))
            cursor = self.editor_svg_input.textCursor()
            cursor.setPosition(anchor_position)
            cursor.setPosition(cursor_position, QTextCursor.MoveMode.KeepAnchor)
            self.editor_svg_input.setTextCursor(cursor)
            self.editor_svg_input.setFocus(Qt.FocusReason.ShortcutFocusReason)

    def _build_editor_context_menu(self, widget: QLineEdit | QTextEdit) -> QMenu:
        menu = widget.createStandardContextMenu()

        # Native widget Undo/Redo uses a separate history and must never be reachable.
        for action in list(menu.actions()):
            menu.removeAction(action)
            if action.isSeparator():
                break

        first_standard_action = menu.actions()[0] if menu.actions() else None
        undo_action = QAction("Undo\tCtrl+Z", menu)
        undo_action.setObjectName("IconHistoryUndoAction")
        redo_action = QAction("Redo\tCtrl+Y", menu)
        redo_action.setObjectName("IconHistoryRedoAction")

        history = self.icon_histories.get(self.selected_uid) if self.selected_uid is not None else None
        undo_action.setEnabled(bool(history and history.can_undo))
        redo_action.setEnabled(bool(history and history.can_redo))
        undo_action.triggered.connect(self.undo_selected_icon)
        redo_action.triggered.connect(self.redo_selected_icon)

        if first_standard_action is None:
            menu.addAction(undo_action)
            menu.addAction(redo_action)
            menu.addSeparator()
        else:
            menu.insertAction(first_standard_action, undo_action)
            menu.insertAction(first_standard_action, redo_action)
            menu.insertSeparator(first_standard_action)
        return menu

    def show_editor_context_menu(self, widget: QLineEdit | QTextEdit, position) -> None:
        self.finish_history_edit()
        self._capture_history_cursor(widget)
        menu = self._build_editor_context_menu(widget)
        menu.exec(widget.mapToGlobal(position))
        self.finish_history_edit()
        menu.deleteLater()

    def _perform_atomic_editor_action(self, widget: QLineEdit | QTextEdit, action) -> None:
        self.finish_history_edit()
        self._capture_history_cursor(widget)
        action()
        self.finish_history_edit()

    @staticmethod
    def _history_shortcut_direction(event) -> str | None:
        if event.matches(QKeySequence.StandardKey.Redo):
            return "redo"
        if event.matches(QKeySequence.StandardKey.Undo):
            return "undo"

        modifiers = event.modifiers()
        control = bool(modifiers & Qt.KeyboardModifier.ControlModifier)
        shift = bool(modifiers & Qt.KeyboardModifier.ShiftModifier)
        disallowed = modifiers & (
            Qt.KeyboardModifier.AltModifier | Qt.KeyboardModifier.MetaModifier
        )
        if not control or disallowed:
            return None
        if event.key() == Qt.Key.Key_Z:
            return "redo" if shift else "undo"
        if event.key() == Qt.Key.Key_Y and not shift:
            return "redo"
        return None

    def set_field_validation(self, widget: QWidget, message: str) -> None:
        widget.setProperty("state", "error" if message else "")
        widget.setToolTip(message)
        repolish(widget)

    def validate_selected_icon(self) -> None:
        icon = self.selected_icon()
        if icon is None:
            self.editor_preview.setPixmap(render_invalid_pixmap(178, "No icon"))
            self.set_field_validation(self.editor_name_input, "")
            self.set_field_validation(self.editor_svg_input, "")
            return

        name_message = self.validate_name_for_editor(icon)
        svg_ok, svg_message, normalized_svg = validate_svg_text(icon.svg)

        if svg_ok:
            self.editor_preview.setPixmap(render_svg_artboard_pixmap(normalized_svg, 178, "#a7a7b0"))
        else:
            self.editor_preview.setPixmap(render_invalid_pixmap(178, "Invalid SVG"))

        self.set_field_validation(self.editor_name_input, name_message)
        self.set_field_validation(self.editor_svg_input, "" if svg_ok else svg_message)

    def validate_name_for_editor(self, icon: IconRecord) -> str:
        if not icon.name:
            return "Icon label cannot be empty."
        if not NAME_RE.fullmatch(icon.name):
            return "Icon label must be lowercase kebab-case, for example icon-one."
        if sum(1 for item in self.icons if item.name == icon.name) > 1:
            return f'The icon label "{icon.name}" is already used.'
        return ""

    def update_editor_from_selection(self) -> None:
        icon = self.selected_icon()
        self._updating_editor = True
        try:
            if icon is None:
                self.editor_name_input.clear()
                self.editor_svg_input.clear()
            else:
                self.editor_name_input.setText(icon.name)
                self.editor_svg_input.setPlainText(icon.svg)
        finally:
            self._updating_editor = False

        self.update_buttons()
        self.validate_selected_icon()

    def calculate_grid_metrics(self) -> tuple[int, int, int, int, int, int]:
        viewport = max(TILE_ZOOM_MIN, self.scroll_area.viewport().width())
        target = max(TILE_ZOOM_MIN, min(TILE_ZOOM_MAX, self.tile_size))
        gap = TILE_GRID_GAP

        # Justified grid: the gap is a fixed constant, identical horizontally and
        # vertically, at every zoom level, and the tile size flexes instead. The
        # zoom setting is a *preferred* tile size that selects the column count
        # whose resulting tile lands closest to it; the tile is then sized to
        # divide the panel evenly so each row fills the full width with even
        # spacing. Rounding the column count keeps the rendered tile as near the
        # requested size as possible, so the zoom percentage stays honest and a
        # window resize simply re-flexes the tile without disturbing the spacing.
        columns = max(1, int((viewport + gap) / (target + gap) + 0.5))
        inner = viewport - (columns - 1) * gap
        tile = max(1, inner // columns)

        # Integer division can leave a few pixels over (always fewer than the
        # column count); center them as a symmetric side margin so every tile
        # stays exactly the same size and the block sits flush and balanced.
        content_width = columns * tile + (columns - 1) * gap
        side_margin = max(0, (viewport - content_width) // 2)
        return columns, tile, tile, gap, gap, side_margin

    def clear_grid(self) -> None:
        while self.grid_layout.count():
            item = self.grid_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def filtered_icons(self) -> list[tuple[int, IconRecord]]:
        query = self.search_input.text().strip().lower()
        results = []
        for index, icon in enumerate(self.icons):
            if not query or query in icon.name.lower() or query in icon.svg.lower():
                results.append((index, icon))
        return results

    def render_grid(self) -> None:
        self._edit_refresh_timer.stop()
        self.clear_grid()
        self._tiles = []

        matches = self.filtered_icons()
        total = len(self.icons)
        self.meta_label.setText(f"{len(matches)} / {total} SVGs from linked_icons.js")

        if not matches:
            empty = QLabel("No SVG names match that search.")
            empty.setObjectName("EmptyState")
            empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.grid_layout.addWidget(empty, 0, 0)
            self._last_grid_signature = self.calculate_grid_metrics()
            return

        columns, tile_width, tile_height, h_gap, v_gap, side_margin = self.calculate_grid_metrics()
        show_label = self.tile_size >= TILE_LABEL_MIN_SIZE
        self.grid_layout.setContentsMargins(side_margin, 0, side_margin, 8)
        self.grid_layout.setHorizontalSpacing(h_gap)
        self.grid_layout.setVerticalSpacing(v_gap)
        self._last_grid_signature = (columns, tile_width, tile_height, h_gap, v_gap, side_margin)

        for visible_index, (source_index, icon) in enumerate(matches):
            row = visible_index // columns
            column = visible_index % columns
            tile = IconTile(
                icon,
                tile_width,
                tile_height,
                selected=(icon.uid == self.selected_uid),
                show_label=show_label,
            )
            tile.clicked.connect(lambda idx=source_index: self.select_icon(idx))
            self.grid_layout.addWidget(tile, row, column)
            self._tiles.append(tile)

    def _reflow_grid(self) -> None:
        if not self._tiles:
            self.render_grid()
            return

        columns, tile_width, tile_height, h_gap, v_gap, side_margin = self.calculate_grid_metrics()
        signature = (columns, tile_width, tile_height, h_gap, v_gap, side_margin)
        if signature == self._last_grid_signature:
            return
        prev_columns = self._last_grid_signature[0]
        self._last_grid_signature = signature

        show_label = self.tile_size >= TILE_LABEL_MIN_SIZE
        self.grid_layout.setContentsMargins(side_margin, 0, side_margin, 8)
        self.grid_layout.setHorizontalSpacing(h_gap)
        self.grid_layout.setVerticalSpacing(v_gap)

        if columns != prev_columns:
            while self.grid_layout.count():
                self.grid_layout.takeAt(0)
            for visible_index, tile in enumerate(self._tiles):
                tile.apply_metrics(tile_width, tile_height, show_label)
                self.grid_layout.addWidget(tile, visible_index // columns, visible_index % columns)
        else:
            for tile in self._tiles:
                tile.apply_metrics(tile_width, tile_height, show_label)

    def set_tile_size(self, size: int, *, from_slider: bool = False) -> None:
        size = max(TILE_ZOOM_MIN, min(TILE_ZOOM_MAX, int(round(size))))
        changed = size != self.tile_size
        self.tile_size = size
        if not from_slider and self.zoom_slider.value() != size:
            self.zoom_slider.blockSignals(True)
            self.zoom_slider.setValue(size)
            self.zoom_slider.blockSignals(False)
        self._update_zoom_ui()
        if changed:
            self._reflow_grid()

    def adjust_tile_size(self, delta: int) -> None:
        self.set_tile_size(self.tile_size + delta)

    def reset_tile_size(self) -> None:
        self.set_tile_size(TILE_DEFAULT_SIZE)

    def _on_zoom_slider(self, value: int) -> None:
        self.set_tile_size(value, from_slider=True)
        percent = round(value / TILE_DEFAULT_SIZE * 100)
        QToolTip.showText(QCursor.pos(), f"{percent}%", self.zoom_slider)

    def _update_zoom_ui(self) -> None:
        self.zoom_out_button.setEnabled(self.tile_size > TILE_ZOOM_MIN)
        self.zoom_in_button.setEnabled(self.tile_size < TILE_ZOOM_MAX)
        percent = round(self.tile_size / TILE_DEFAULT_SIZE * 100)
        self.zoom_slider.setToolTip(f"Icon size: {percent}%  ·  double-click to reset")

    def _setup_zoom_shortcuts(self) -> None:
        self._zoom_shortcuts = []
        specs = [
            ("Ctrl+=", TILE_ZOOM_STEP),
            ("Ctrl++", TILE_ZOOM_STEP),
            ("Ctrl+-", -TILE_ZOOM_STEP),
        ]
        for sequence, delta in specs:
            shortcut = QShortcut(QKeySequence(sequence), self)
            shortcut.setContext(Qt.ShortcutContext.WindowShortcut)
            shortcut.activated.connect(lambda checked=False, d=delta: self.adjust_tile_size(d))
            self._zoom_shortcuts.append(shortcut)

    def _setup_history_shortcuts(self) -> None:
        self._history_shortcuts = []
        specs = (
            ("Ctrl+Z", self.undo_selected_icon),
            ("Ctrl+Y", self.redo_selected_icon),
            ("Ctrl+Shift+Z", self.redo_selected_icon),
        )
        for sequence, handler in specs:
            shortcut = QShortcut(QKeySequence(sequence), self.editor_panel)
            shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            shortcut.activated.connect(handler)
            self._history_shortcuts.append(shortcut)

    def select_icon(self, index: int) -> None:
        if index < 0 or index >= len(self.icons):
            return
        self.finish_history_edit()
        self.selected_uid = self.icons[index].uid
        self.update_editor_from_selection()
        self.refresh_tile_selection()

    def refresh_tile_selection(self) -> None:
        for item_index in range(self.grid_layout.count()):
            widget = self.grid_layout.itemAt(item_index).widget()
            if isinstance(widget, IconTile):
                selected = widget.icon_record.uid == self.selected_uid
                if widget.selected != selected:
                    widget.selected = selected
                    widget.update()

    def add_icon(self) -> None:
        self.finish_history_edit()
        used_names = {icon.name for icon in self.icons}
        name = unique_icon_name("new-icon", used_names)

        new_icon = IconRecord(name, DEFAULT_SVG)
        self.icons = sorted_icons([*self.icons, new_icon])
        self.icon_histories[new_icon.uid] = IconHistory.for_icon(new_icon)
        self.selected_uid = new_icon.uid
        self.search_input.clear()
        self.set_dirty(self.icons != self.saved_icons)
        self.update_editor_from_selection()
        self.render_grid()

    def delete_selected_icon(self) -> None:
        self.finish_history_edit()
        index = self.selected_index()
        if index is None:
            return

        icon = self.icons[index]
        next_icons = list(self.icons)
        del next_icons[index]
        self.icons = next_icons
        self.icon_histories.pop(icon.uid, None)
        if self.icons:
            self.selected_uid = self.icons[min(index, len(self.icons) - 1)].uid
        else:
            self.selected_uid = None
        self.set_dirty(self.icons != self.saved_icons)
        self.update_editor_from_selection()
        self.render_grid()

    def replace_selected_icon(
        self,
        *,
        name: str | None = None,
        svg: str | None = None,
        history_field: str | None = None,
    ) -> None:
        index = self.selected_index()
        if index is None:
            return

        old_icon = self.icons[index]
        next_icon = IconRecord(
            old_icon.name if name is None else name,
            old_icon.svg if svg is None else svg,
            old_icon.uid,
        )

        if next_icon == old_icon:
            return

        self.icons[index] = next_icon
        self.icons = sorted_icons(self.icons)
        self.selected_uid = next_icon.uid
        if history_field is not None:
            self._record_icon_history(old_icon, next_icon, history_field)
        self.set_dirty(self.icons != self.saved_icons)
        self.validate_selected_icon()
        # Debounce so per-keystroke edits do not rebuild the whole gallery.
        self._edit_refresh_timer.start(120)

    def on_editor_name_edited(self, text: str) -> None:
        if self._updating_editor or self._normalizing_main_name:
            return

        normalized = normalize_name_live(text)
        if normalized != text:
            cursor_position = self.editor_name_input.cursorPosition()
            normalized_prefix = normalize_name_live(text[:cursor_position])
            self._normalizing_main_name = True
            self.editor_name_input.setText(normalized)
            self.editor_name_input.setCursorPosition(len(normalized_prefix))
            self._normalizing_main_name = False

        self.replace_selected_icon(name=normalized, history_field="name")

    def on_editor_svg_changed(self) -> None:
        if self._updating_editor:
            return
        self.replace_selected_icon(
            svg=self.editor_svg_input.toPlainText(),
            history_field="svg",
        )

    def flash_editor_svg_confirmation(self, color: str) -> None:
        self.editor_svg_input.show_confirmation_flash(color)

    def clear_editor_svg(self) -> None:
        if self.selected_icon() is None:
            return
        self._perform_atomic_editor_action(self.editor_svg_input, self.editor_svg_input.clear)
        self.flash_editor_svg_confirmation(CONFIRMATION_FLASH_CLEAR_COLOR)
        self.editor_svg_input.setFocus(Qt.FocusReason.ShortcutFocusReason)

    def paste_editor_svg(self) -> None:
        if self.selected_icon() is None:
            return
        clipboard_text = QGuiApplication.clipboard().text()
        self._perform_atomic_editor_action(
            self.editor_svg_input,
            lambda: self.editor_svg_input.setPlainText(clipboard_text)
        )
        self.flash_editor_svg_confirmation(CONFIRMATION_FLASH_PASTE_COLOR)
        self.editor_svg_input.setFocus(Qt.FocusReason.ShortcutFocusReason)

    def copy_editor_svg(self) -> None:
        if self.selected_icon() is None:
            return
        QGuiApplication.clipboard().setText(self.editor_svg_input.toPlainText())
        self.flash_editor_svg_confirmation(CONFIRMATION_FLASH_COPY_COLOR)

    def export_selected_svg(self) -> None:
        icon = self.selected_icon()
        if icon is None:
            return

        ok, message, normalized_svg = validate_svg_text(self.editor_svg_input.toPlainText())
        if not ok:
            self.set_field_validation(self.editor_svg_input, message)
            self.editor_svg_input.setFocus(Qt.FocusReason.ShortcutFocusReason)
            return

        export_dir = self._last_export_dir if self._last_export_dir.exists() else self.source_path.parent
        default_name = normalize_name_final(icon.name) or "icon"
        default_path = export_dir / f"{default_name}.svg"
        selected_path, _ = QFileDialog.getSaveFileName(
            self,
            "Export SVG",
            str(default_path),
            "SVG files (*.svg);;All files (*.*)",
        )
        if not selected_path:
            return

        export_path = Path(selected_path)
        if export_path.suffix.lower() != ".svg":
            export_path = export_path.with_suffix(".svg")

        try:
            export_path.write_text(normalized_svg + "\n", encoding="utf-8", newline="\n")
        except OSError as error:
            QMessageBox.critical(self, "Could not export SVG", str(error))
            return

        self._last_export_dir = export_path.parent

    def focus_first_save_issue(self) -> None:
        used_names: set[str] = set()

        for icon in self.icons:
            name = normalize_name_final(icon.name)
            if not name or not NAME_RE.fullmatch(name) or name in used_names:
                self.focus_icon_field(icon.uid, self.editor_name_input)
                return
            used_names.add(name)

            ok, _, _ = validate_svg_text(icon.svg)
            if not ok:
                self.focus_icon_field(icon.uid, self.editor_svg_input)
                return

    def focus_icon_field(self, uid: int, field: QWidget) -> None:
        self.finish_history_edit()
        self.selected_uid = uid
        self.update_editor_from_selection()
        self.render_grid()
        field.setFocus(Qt.FocusReason.ShortcutFocusReason)

    def validate_icons_for_save(self) -> tuple[list[IconRecord] | None, str]:
        used_names: set[str] = set()
        normalized_icons: list[IconRecord] = []

        for icon in self.icons:
            name = normalize_name_final(icon.name)
            if not name:
                return None, "Cannot save: one icon has an empty label."
            if not NAME_RE.fullmatch(name):
                return None, f'Cannot save: "{icon.name}" is not valid lowercase kebab-case.'
            if name in used_names:
                return None, f'Cannot save: duplicate icon label "{name}".'
            used_names.add(name)

            ok, message, normalized_svg = validate_svg_text(icon.svg)
            if not ok:
                return None, f'Cannot save "{name}": {message}'
            normalized_icons.append(IconRecord(name, normalized_svg, icon.uid))

        return sorted_icons(normalized_icons), ""

    def save_file(self) -> None:
        if not self.dirty:
            return

        self.finish_history_edit()
        try:
            normalized_icons, _message = self.validate_icons_for_save()
            if normalized_icons is None:
                self.focus_first_save_issue()
                return

            self.icon_file.save_icons(normalized_icons)
            self.icons = normalized_icons
            for icon in normalized_icons:
                history = self.icon_histories.get(icon.uid)
                if history is None:
                    self.icon_histories[icon.uid] = IconHistory.for_icon(icon)
                else:
                    history.reconcile_current(icon)
            self.saved_icons = copy.deepcopy(normalized_icons)
            self.set_dirty(False)
            self.update_editor_from_selection()
            self.render_grid()
        except (OSError, IconFormatError) as error:
            QMessageBox.critical(self, "Could not save linked_icons.js", str(error))

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt method name
        if not self.dirty:
            event.accept()
            return

        answer = QMessageBox.question(
            self,
            "Unsaved icon changes",
            "Save changes to linked_icons.js before closing?",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )

        if answer == QMessageBox.StandardButton.Cancel:
            event.ignore()
            return
        if answer == QMessageBox.StandardButton.Save:
            self.save_file()
            if self.dirty:
                event.ignore()
                return

        event.accept()

    def _position_drop_overlay(self) -> None:
        overlay = getattr(self, "drop_overlay", None)
        if overlay is None:
            return
        overlay.setGeometry(self.scroll_area.geometry())

    def _cursor_over_gallery(self) -> bool:
        local = self.gallery_panel.mapFromGlobal(QCursor.pos())
        return self.gallery_panel.rect().contains(local)

    def _drag_has_files(self, event) -> bool:
        return bool(event.mimeData().hasUrls())

    def _show_drop_overlay(self) -> None:
        self._position_drop_overlay()
        self.drop_overlay.raise_()
        self.drop_overlay.show()

    def _hide_drop_overlay(self) -> None:
        overlay = getattr(self, "drop_overlay", None)
        if overlay is not None:
            overlay.hide()

    def dragEnterEvent(self, event) -> None:  # noqa: N802 - Qt method name
        if self._drag_has_files(event) and self._cursor_over_gallery():
            self._show_drop_overlay()
            event.acceptProposedAction()
            return
        self._hide_drop_overlay()
        event.ignore()

    def dragMoveEvent(self, event) -> None:  # noqa: N802 - Qt method name
        if self._drag_has_files(event) and self._cursor_over_gallery():
            self._show_drop_overlay()
            event.acceptProposedAction()
            return
        self._hide_drop_overlay()
        event.ignore()

    def dragLeaveEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self._hide_drop_overlay()
        super().dragLeaveEvent(event)

    def dropEvent(self, event) -> None:  # noqa: N802 - Qt method name
        self._hide_drop_overlay()
        if not (self._drag_has_files(event) and self._cursor_over_gallery()):
            event.ignore()
            return

        paths = [
            Path(url.toLocalFile())
            for url in event.mimeData().urls()
            if url.isLocalFile() and url.toLocalFile()
        ]
        event.acceptProposedAction()
        if paths:
            self._import_svg_files(paths)

    def _import_svg_files(self, paths: list[Path]) -> None:
        self.finish_history_edit()
        used_names = {icon.name for icon in self.icons}
        imported: list[IconRecord] = []

        for path in paths:
            if path.suffix.lower() != ".svg":
                continue
            try:
                raw = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            ok, _message, normalized_svg = validate_svg_text(raw)
            if not ok:
                continue

            base = normalize_name_final(path.stem) or "icon"
            name = unique_icon_name(base, used_names)
            used_names.add(name)
            imported.append(IconRecord(name, normalized_svg))

        if not imported:
            return

        self.icons = sorted_icons([*self.icons, *imported])
        for icon in imported:
            self.icon_histories[icon.uid] = IconHistory.for_icon(icon)
        self.selected_uid = imported[-1].uid
        self.search_input.clear()
        self.set_dirty(self.icons != self.saved_icons)
        self.update_editor_from_selection()
        self.render_grid()

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt method name
        super().resizeEvent(event)
        self._position_drop_overlay()
        signature = self.calculate_grid_metrics()
        if signature != self._last_grid_signature:
            self._resize_timer.start(80)

    def showEvent(self, event) -> None:  # noqa: N802 - Qt method name
        super().showEvent(event)
        QTimer.singleShot(0, self.render_grid)

    def eventFilter(self, watched, event) -> bool:  # noqa: N802 - Qt method name
        editor_name_input = getattr(self, "editor_name_input", None)
        editor_svg_input = getattr(self, "editor_svg_input", None)
        if watched in (editor_name_input, editor_svg_input) and watched is not None:
            if event.type() == QEvent.Type.FocusOut:
                self.finish_history_edit()
            elif event.type() == QEvent.Type.KeyPress:
                direction = self._history_shortcut_direction(event)
                if direction == "undo":
                    self.undo_selected_icon()
                    event.accept()
                    return True
                if direction == "redo":
                    self.redo_selected_icon()
                    event.accept()
                    return True
                if event.matches(QKeySequence.StandardKey.Cut):
                    self._perform_atomic_editor_action(watched, watched.cut)
                    event.accept()
                    return True
                if event.matches(QKeySequence.StandardKey.Paste):
                    self._perform_atomic_editor_action(watched, watched.paste)
                    event.accept()
                    return True
                self._capture_history_cursor(watched)
            elif event.type() in (QEvent.Type.InputMethod, QEvent.Type.Drop):
                self._capture_history_cursor(watched)

        if watched is self.scroll_area.viewport():
            if event.type() == QEvent.Type.Resize:
                self._position_drop_overlay()
                self._resize_timer.start(40)
            elif event.type() == QEvent.Type.Wheel and (
                event.modifiers() & Qt.KeyboardModifier.ControlModifier
            ):
                delta = event.angleDelta().y()
                if delta:
                    step = int(round(TILE_ZOOM_WHEEL_STEP * (delta / 120.0)))
                    if step == 0:
                        step = 1 if delta > 0 else -1
                    self.adjust_tile_size(step)
                return True
        return super().eventFilter(watched, event)


STYLE_SHEET = """
QWidget {
    background-color: #202024;
    color: #96969e;
    font-family: "Segoe UI";
    font-size: 13px;
}

QMainWindow#MainWindow {
    background-color: #202024;
}

QFrame#TopBar {
    background-color: #202024;
}

QFrame#GalleryPanel {
    background-color: transparent;
}

QFrame#EditorPanel {
    border: 1px solid #383840;
    border-radius: 16px;
    background-color: #24242a;
}

QLabel#Title {
    color: #a9a9b1;
    font-size: 22px;
    font-weight: 700;
}

QLabel#Meta {
    color: #76767f;
    font-size: 13px;
}

QLineEdit#SearchInput,
QLineEdit#NameInput,
QLineEdit#EditorNameInput {
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid #3a3a42;
    border-radius: 19px;
    background-color: #19191d;
    color: #c4c4cc;
    selection-background-color: #0a84ff;
}

QLineEdit#SearchInput {
    border-radius: 12px;
}

QLineEdit#NameInput,
QLineEdit#EditorNameInput {
    border-radius: 12px;
    min-height: 42px;
}

QPushButton {
    min-height: 38px;
    padding: 0 16px;
    border: 1px solid #3b3b43;
    border-radius: 19px;
    background-color: #2a2a2f;
    color: #a9a9b1;
}

QPushButton:hover {
    border-color: #55555e;
    background-color: #303036;
    color: #c4c4cc;
}

QPushButton#PrimaryButton,
QPushButton#SaveButton[dirty="true"] {
    border-color: #0a84ff;
    background-color: #0a3e78;
    color: #dbeeff;
}

QPushButton#PrimaryButton:hover,
QPushButton#SaveButton[dirty="true"]:hover {
    background-color: #0a4f99;
}

QPushButton#SaveButton:disabled {
    border-color: #323239;
    background-color: #26262b;
    color: #5f5f68;
}

QPushButton#DangerButton {
    border-color: #a33731;
    background-color: #331f20;
    color: #e58d88;
}

QPushButton#DangerButton:hover {
    border-color: #df453d;
    background-color: #432122;
}

QPushButton#DangerButton:disabled {
    border-color: #3a2a2b;
    background-color: #282226;
    color: #66585a;
}

QPushButton[toolbar="true"] {
    border-radius: 12px;
}

QPushButton#CloseButton {
    min-width: 36px;
    min-height: 36px;
    max-width: 36px;
    max-height: 36px;
    padding: 0;
    border-radius: 18px;
    font-size: 18px;
}

QWidget#ZoomControls {
    background-color: transparent;
    border: 0;
}

QSlider#ZoomSlider {
    min-height: 24px;
}

QSlider#ZoomSlider::groove:horizontal {
    height: 5px;
    border-radius: 2px;
    background-color: #34343c;
}

QSlider#ZoomSlider::sub-page:horizontal {
    height: 5px;
    border-radius: 2px;
    background-color: qlineargradient(
        x1:0, y1:0, x2:1, y2:0,
        stop:0 #0a6fd6, stop:1 #2a97ff
    );
}

QSlider#ZoomSlider::add-page:horizontal {
    height: 5px;
    border-radius: 2px;
    background-color: #34343c;
}

QSlider#ZoomSlider::handle:horizontal {
    width: 15px;
    height: 15px;
    margin: -6px 0;
    border-radius: 8px;
    background-color: qlineargradient(
        x1:0, y1:0, x2:0, y2:1,
        stop:0 #ffffff, stop:1 #dcdce3
    );
    border: 1px solid #202027;
}

QSlider#ZoomSlider::handle:horizontal:hover {
    background-color: #ffffff;
    border-color: #0a84ff;
}

QSlider#ZoomSlider::handle:horizontal:pressed {
    background-color: #ffffff;
    border-color: #0a84ff;
}

QScrollArea#GalleryScroll {
    border: 0;
    background-color: transparent;
}

QWidget#Gallery {
    background-color: transparent;
}

QWidget#IconTile {
    background-color: transparent;
}

QFrame#EditorPreviewCard {
    border: 1px solid #3b3b43;
    border-radius: 14px;
    background-color: #2b2b31;
}

QLabel#EditorPreview {
    background-color: transparent;
}

QLabel#PanelLabel {
    color: #81818a;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
}

QWidget#EditorHistoryHeader {
    background-color: transparent;
}

QPushButton#HistoryButton {
    min-width: 52px;
    min-height: 26px;
    max-height: 26px;
    padding: 0 10px;
    border: 1px solid #3f3f48;
    border-radius: 10px;
    background-color: #29292f;
    color: #aaaab3;
    font-size: 11px;
    font-weight: 600;
}

QPushButton#HistoryButton:hover {
    border-color: #5a5a64;
    background-color: #323238;
    color: #d1d1d8;
}

QPushButton#HistoryButton:pressed {
    border-color: #0a84ff;
    background-color: #233a50;
    color: #e3f1ff;
}

QPushButton#HistoryButton:disabled {
    border-color: #33333a;
    background-color: #25252a;
    color: #5f5f68;
}

QTextEdit#EditorSvgInput {
    border: 1px solid #3a3a42;
    border-radius: 14px;
    background-color: #18181d;
    color: #b9b9c2;
    padding: 12px;
    selection-background-color: #0a84ff;
}

QTextEdit#EditorSvgInput:disabled,
QLineEdit#EditorNameInput:disabled {
    color: #5f5f68;
    background-color: #202025;
}

QLineEdit#EditorNameInput[state="error"] {
    border-color: #b44842;
    background-color: #211a1c;
}

QFrame#EditorToolBar {
    min-height: 34px;
    background-color: transparent;
}

QPushButton#EditorToolButton {
    min-height: 30px;
    max-height: 30px;
    padding: 0 12px;
    border: 1px solid #3f3f48;
    border-radius: 12px;
    background-color: #29292f;
    color: #aaaab3;
    font-size: 12px;
    font-weight: 600;
}

QPushButton#EditorToolButton:hover {
    border-color: #5a5a64;
    background-color: #323238;
    color: #d1d1d8;
}

QPushButton#EditorToolButton:pressed {
    border-color: #0a84ff;
    background-color: #233a50;
    color: #e3f1ff;
}

QPushButton#EditorToolButton:disabled {
    border-color: #33333a;
    background-color: #25252a;
    color: #5f5f68;
}

QLabel#EmptyState {
    color: #777780;
    font-size: 16px;
    padding-top: 80px;
}

QDialog#EditorDialog {
    background-color: #202024;
}

QFrame#DialogHeader,
QFrame#DialogFooter {
    background-color: #24242a;
    border: 0;
}

QFrame#DialogHeader {
    border-bottom: 1px solid #3a3a42;
}

QFrame#DialogFooter {
    border-top: 1px solid #3a3a42;
}

QLabel#DialogTitle {
    color: #a9a9b1;
    font-size: 22px;
    font-weight: 700;
}

QFrame#DialogUpper,
QFrame#CodeArea {
    background-color: #202024;
}

QFrame#PreviewCard,
QFrame#NameCard {
    border: 1px solid #3a3a42;
    border-radius: 16px;
    background-color: #2a2a30;
}

QLabel#FieldLabel {
    color: #777780;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
}

QLabel#Hint {
    color: #777780;
    line-height: 18px;
}

QTextEdit#SvgInput {
    border: 1px solid #3a3a42;
    border-radius: 16px;
    background-color: #18181c;
    color: #b6b6bf;
    padding: 14px;
    selection-background-color: #0a84ff;
}

QLabel#ValidationMessage {
    color: #777780;
    min-height: 24px;
}

QLabel#ValidationMessage[kind="success"] {
    color: #8ed9a2;
}

QLabel#ValidationMessage[kind="error"] {
    color: #ff8d86;
}

QScrollBar:vertical,
QScrollBar:horizontal {
    border: 0;
    background: transparent;
    background-color: transparent;
}

QScrollBar:vertical {
    width: 10px;
    margin: 18px 0;
}

QScrollBar:horizontal {
    height: 10px;
    margin: 0 18px;
}

QScrollBar::handle:vertical,
QScrollBar::handle:horizontal {
    border: 0;
    border-radius: 3px;
    background: #494954;
}

QScrollBar::handle:vertical {
    min-height: 42px;
}

QScrollBar::handle:horizontal {
    min-width: 42px;
}

QScrollBar::handle:vertical:hover,
QScrollBar::handle:horizontal:hover {
    background: #5a5a66;
}

QScrollBar::handle:vertical:pressed,
QScrollBar::handle:horizontal:pressed {
    background: #0a6fd6;
}

QScrollBar::add-page:vertical,
QScrollBar::sub-page:vertical,
QScrollBar::add-page:horizontal,
QScrollBar::sub-page:horizontal {
    background: transparent;
    background-color: transparent;
}

QScrollBar::add-line:vertical,
QScrollBar::sub-line:vertical {
    height: 18px;
    border: 0;
    background: transparent;
    background-color: transparent;
}

QScrollBar::sub-line:vertical {
    subcontrol-origin: margin;
    subcontrol-position: top;
}

QScrollBar::add-line:vertical {
    subcontrol-origin: margin;
    subcontrol-position: bottom;
}

QScrollBar::add-line:horizontal,
QScrollBar::sub-line:horizontal {
    width: 18px;
    border: 0;
    background: transparent;
    background-color: transparent;
}

QScrollBar::sub-line:horizontal {
    subcontrol-origin: margin;
    subcontrol-position: left;
}

QScrollBar::add-line:horizontal {
    subcontrol-origin: margin;
    subcontrol-position: right;
}

QScrollBar::up-arrow:vertical,
QScrollBar::down-arrow:vertical,
QScrollBar::left-arrow:horizontal,
QScrollBar::right-arrow:horizontal {
    width: 8px;
    height: 6px;
    background: transparent;
    background-color: transparent;
}
"""


def main() -> int:
    set_windows_app_user_model_id()

    source_path = Path(__file__).resolve().with_name(SOURCE_FILE_NAME)
    editor_config = load_editor_config_or_default(source_path)
    server_name, mutex_name = single_instance_names(source_path)

    app = QApplication(sys.argv)
    app.setApplicationName(editor_config.app_title)
    if hasattr(app, "setApplicationDisplayName"):
        app.setApplicationDisplayName(editor_config.app_title)
    app.setStyleSheet(STYLE_SHEET)
    app.setFont(QFont("Segoe UI", 10))

    single_instance = SingleInstanceGuard(server_name, mutex_name, app)
    if not single_instance.acquire():
        if single_instance.notified_existing_instance:
            return 0

        QMessageBox.critical(
            None,
            editor_config.app_title,
            f"Could not start the single-instance listener: {single_instance.listen_error}",
        )
        return 1
    app.aboutToQuit.connect(single_instance.release)

    app_icon = build_app_icon()
    if not app_icon.isNull():
        app.setWindowIcon(app_icon)

    window = MainWindow(editor_config)
    if not app_icon.isNull():
        window.setWindowIcon(app_icon)
    single_instance.set_window(window)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
