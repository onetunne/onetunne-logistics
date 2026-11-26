"""Transcript IO + subtitle generation (SRT, compact text, styled ASS incl. TikTok-style word highlight)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Word:
    start: float
    end: float
    word: str


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)


# ---------------------------------------------------------------- reading

_SRT_TIME = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")


def _t(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000


def read_srt(path: str | Path) -> list[Segment]:
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    segs: list[Segment] = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        lines = [ln for ln in block.strip().split("\n") if ln.strip()]
        for i, ln in enumerate(lines):
            m = _SRT_TIME.search(ln)
            if m:
                g = m.groups()
                body = " ".join(lines[i + 1:]).strip()
                if body:
                    segs.append(Segment(_t(*g[:4]), _t(*g[4:]), body))
                break
    return segs


def read_transcript(path: str | Path) -> list[Segment]:
    """Our JSON (from `mtk transcribe`) or .srt."""
    p = Path(path)
    if p.suffix.lower() == ".srt":
        return read_srt(p)
    data = json.loads(p.read_text(encoding="utf-8"))
    segs = []
    for s in data.get("segments", []):
        words = [Word(float(w["start"]), float(w["end"]), str(w["word"])) for w in s.get("words") or []
                 if w.get("start") is not None and w.get("end") is not None]
        segs.append(Segment(float(s["start"]), float(s["end"]), str(s["text"]).strip(), words))
    return segs


# ---------------------------------------------------------------- writing

def srt_time(t: float) -> str:
    t = max(0.0, t)
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segs: list[Segment], path: str | Path) -> None:
    out = []
    for i, s in enumerate(segs, 1):
        out.append(f"{i}\n{srt_time(s.start)} --> {srt_time(s.end)}\n{s.text.strip()}\n")
    Path(path).write_text("\n".join(out), encoding="utf-8")


def compact_lines(segs: list[Segment], max_span: float = 20.0) -> list[str]:
    """Merge segments into '[H:MM:SS] text' lines of <= max_span seconds — the cheapest form for the model."""
    lines, cur_start, cur_text = [], None, []
    for s in segs:
        if cur_start is None:
            cur_start, cur_text = s.start, [s.text.strip()]
            continue
        if s.end - cur_start > max_span:
            lines.append(f"[{_hms(cur_start)}] {' '.join(cur_text)}")
            cur_start, cur_text = s.start, [s.text.strip()]
        else:
            cur_text.append(s.text.strip())
    if cur_start is not None:
        lines.append(f"[{_hms(cur_start)}] {' '.join(cur_text)}")
    return lines


def _hms(t: float) -> str:
    t = int(max(0, t))
    return f"{t // 3600}:{(t % 3600) // 60:02d}:{t % 60:02d}"


def text_in_range(segs: list[Segment], start: float, end: float) -> str:
    return " ".join(s.text.strip() for s in segs if s.end > start and s.start < end)


# ---------------------------------------------------------------- ASS

def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_escape(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", r"\N")


WHITE, YELLOW, BLACK = "&H00FFFFFF", "&H0000FFFF", "&H00000000"
HIGHLIGHT = r"{\c&H00FFFF&}"
RESET = r"{\r}"


def _style(name: str, font: str, size: int, bold: bool, outline: int, shadow: int, align: int,
           margin_v: int, margin_h: int, border_style: int = 1, back: str = "&H80000000") -> str:
    b = -1 if bold else 0
    return (f"Style: {name},{font},{size},{WHITE},{YELLOW},{BLACK},{back},{b},0,0,0,100,100,0,0,"
            f"{border_style},{outline},{shadow},{align},{margin_h},{margin_h},{margin_v},1")


def build_ass(width: int, height: int, segs: list[Segment], style: str = "clean", offset: float = 0.0,
              clip_duration: float | None = None, title: str | None = None, title_dur: float = 3.0,
              font: str = "Arial", uppercase: bool | None = None) -> str:
    """Return a complete ASS document sized to the output frame."""
    h = height
    short = min(width, height)
    styles = [
        _style("Clean", font, max(18, int(h * 0.045 if width >= height else short * 0.065)), True,
               max(2, int(short * 0.004)), 1, 2, int(h * 0.06), int(width * 0.06)),
        _style("Tiktok", font, max(20, int(short * 0.075)), True, max(3, int(short * 0.007)), 2, 2,
               int(h * 0.28), int(width * 0.07)),
        _style("Title", font, max(22, int(short * 0.07)), True, max(2, int(short * 0.004)), 0, 8,
               int(h * 0.10), int(width * 0.06), border_style=3, back="&H64000000"),
    ]
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
        "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        *styles, "",
        "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    events: list[str] = []
    limit = clip_duration if clip_duration is not None else float("inf")

    def add(start: float, end: float, sty: str, text: str, layer: int = 0) -> None:
        s, e = start - offset, end - offset
        if e <= 0 or s >= limit:
            return
        s, e = max(0.0, s), min(limit, e)
        if e - s < 0.05:
            return
        events.append(f"Dialogue: {layer},{ass_time(s)},{ass_time(e)},{sty},,0,0,0,,{text}")

    if title:
        add(offset, offset + title_dur, "Title", r"{\fad(250,250)}" + ass_escape(title), layer=1)

    if style == "tiktok":
        up = True if uppercase is None else uppercase
        words = [w for s in segs for w in s.words]
        if words:
            for group in group_words(words):
                for i, w in enumerate(group):
                    end = group[i + 1].start if i + 1 < len(group) else max(w.end, w.start + 0.25)
                    parts = []
                    for j, g in enumerate(group):
                        token = ass_escape(g.word.strip())
                        token = token.upper() if up else token
                        parts.append(f"{HIGHLIGHT}{token}{RESET}" if j == i else token)
                    add(w.start, end, "Tiktok", " ".join(parts))
        else:  # no word timings: short chunks of segment text
            for s in segs:
                for cs, ce, chunk in split_segment(s, max_chars=18):
                    add(cs, ce, "Tiktok", ass_escape(chunk.upper() if up else chunk))
    elif style == "clean":
        for s in segs:
            add(s.start, s.end, "Clean", ass_escape(wrap_two_lines(s.text.strip(), 42)))
    return "\n".join(head + events) + "\n"


def group_words(words: list[Word], max_words: int = 3, max_dur: float = 1.6, max_chars: int = 18,
                max_gap: float = 0.6) -> list[list[Word]]:
    groups: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if not w.word.strip():
            continue
        if cur and (len(cur) >= max_words or w.end - cur[0].start > max_dur
                    or sum(len(x.word.strip()) + 1 for x in cur) + len(w.word.strip()) > max_chars
                    or w.start - cur[-1].end > max_gap):
            groups.append(cur)
            cur = []
        cur.append(w)
        if w.word.strip()[-1:] in ".!?…":
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return groups


def split_segment(seg: Segment, max_chars: int = 18) -> list[tuple[float, float, str]]:
    words = seg.text.split()
    if not words:
        return []
    chunks, cur = [], []
    for w in words:
        if cur and len(" ".join(cur + [w])) > max_chars:
            chunks.append(" ".join(cur))
            cur = []
        cur.append(w)
    if cur:
        chunks.append(" ".join(cur))
    total = sum(len(c) for c in chunks) or 1
    out, t = [], seg.start
    dur = max(0.1, seg.end - seg.start)
    for c in chunks:
        d = dur * len(c) / total
        out.append((t, t + d, c))
        t += d
    return out


def wrap_two_lines(text: str, width: int) -> str:
    if len(text) <= width:
        return text
    mid = len(text) // 2
    left = text.rfind(" ", 0, mid + 1)
    right = text.find(" ", mid)
    cut = left if left > 0 and (right < 0 or mid - left <= right - mid) else right
    if cut <= 0:
        return text
    return text[:cut].strip() + "\n" + text[cut:].strip()
