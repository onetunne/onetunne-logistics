"""Shared helpers: paths, subprocess, time formatting, JSON IO. Stdlib only."""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Sequence

IS_WINDOWS = os.name == "nt"
IS_MAC = sys.platform == "darwin"

VIDEO_EXT = {
    ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".mts", ".m2ts", ".mxf",
    ".wmv", ".flv", ".3gp", ".mpg", ".mpeg", ".ts", ".braw", ".r3d",
}
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aif", ".aiff"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif"}
MEDIA_EXT = VIDEO_EXT | AUDIO_EXT


def assistant_home() -> Path:
    """~/.claude-assistant (override: ASSISTANT_HOME)."""
    env = os.environ.get("ASSISTANT_HOME")
    return Path(env).expanduser() if env else Path.home() / ".claude-assistant"


def claude_home() -> Path:
    """~/.claude (Claude Code honours CLAUDE_CONFIG_DIR)."""
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(env).expanduser() if env else Path.home() / ".claude"


def which(name: str) -> str | None:
    return shutil.which(name)


def run(cmd: Sequence[str], timeout: float | None = None, cwd: str | Path | None = None,
        input_text: str | None = None) -> tuple[int, str, str]:
    """Run a command without a shell. Returns (code, stdout, stderr); never raises on non-zero."""
    try:
        p = subprocess.run(
            list(cmd), capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, cwd=str(cwd) if cwd else None, input=input_text,
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {cmd[0]}"


def fmt_ts(seconds: float, ms: bool = False) -> str:
    """Seconds -> H:MM:SS (or H:MM:SS.mmm). Compact for humans and the model."""
    if seconds is None or seconds != seconds:  # NaN
        return "?"
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    if ms:
        return f"{h}:{m:02d}:{s:06.3f}"
    return f"{h}:{m:02d}:{int(s):02d}"


_TS_RE = re.compile(r"^(?:(\d+):)?(?:(\d+):)?(\d+(?:[.,]\d+)?)$")


def parse_ts(text: str | float | int) -> float:
    """'1:02:03.5' | '62.5' | '1:05' -> seconds."""
    if isinstance(text, (int, float)):
        return float(text)
    t = str(text).strip()
    m = _TS_RE.match(t)
    if not m:
        raise ValueError(f"bad time: {text!r}")
    a, b, c = m.groups()
    sec = float(c.replace(",", "."))
    if a is not None and b is not None:
        return int(a) * 3600 + int(b) * 60 + sec
    if a is not None:
        return int(a) * 60 + sec
    return sec


def human_size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data: Any) -> None:
    """Atomic JSON write (UTF-8, pretty)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def iter_files(paths: Iterable[str | Path], exts: set[str] | None = None, recursive: bool = True) -> list[Path]:
    """Expand files/dirs into a sorted, de-duplicated list of files with given extensions."""
    out: list[Path] = []
    seen: set[str] = set()
    for p in paths:
        p = Path(p).expanduser()
        cands: Iterable[Path]
        if p.is_dir():
            cands = p.rglob("*") if recursive else p.glob("*")
        else:
            cands = [p]
        for c in cands:
            if not c.is_file():
                continue
            if exts and c.suffix.lower() not in exts:
                continue
            # skip our own outputs and hidden/system files
            if any(part.startswith(".") for part in c.parts[-2:]):
                continue
            key = str(c.resolve()).lower() if IS_WINDOWS else str(c.resolve())
            if key not in seen:
                seen.add(key)
                out.append(c)
    return sorted(out, key=lambda x: str(x).lower())


def system_font() -> str | None:
    """A font file that has Cyrillic glyphs, for ffmpeg drawtext. None if not found."""
    candidates = []
    if IS_WINDOWS:
        windir = os.environ.get("WINDIR", r"C:\Windows")
        candidates += [Path(windir) / "Fonts" / f for f in ("arialbd.ttf", "arial.ttf", "segoeuib.ttf", "segoeui.ttf")]
    elif IS_MAC:
        candidates += [Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
                       Path("/System/Library/Fonts/Supplemental/Arial.ttf"), Path("/Library/Fonts/Arial.ttf")]
    candidates += [Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
                   Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
                   Path("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf")]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def fonts_dir() -> str | None:
    if IS_WINDOWS:
        d = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
        return str(d) if d.exists() else None
    if IS_MAC:
        return "/System/Library/Fonts/Supplemental" if Path("/System/Library/Fonts/Supplemental").exists() else None
    return None  # fontconfig on Linux


def ff_filter_path(path: str | Path) -> str:
    """Escape a filesystem path for use inside an ffmpeg filtergraph option value."""
    s = str(path).replace("\\", "/")
    s = s.replace(":", r"\:").replace("'", r"\'")
    return f"'{s}'"


def os_label() -> str:
    return f"{platform.system()} {platform.release()} ({platform.machine()})"


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)
