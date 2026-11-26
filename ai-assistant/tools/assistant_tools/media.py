"""FFmpeg/ffprobe wrappers and signal detectors (scenes, silence, loudness). Stdlib only."""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from .common import assistant_home, load_json, run, save_json

FFMPEG = os.environ.get("MTK_FFMPEG") or "ffmpeg"
FFPROBE = os.environ.get("MTK_FFPROBE") or "ffprobe"


class MediaError(RuntimeError):
    pass


@dataclass
class MediaInfo:
    path: str
    duration: float = 0.0
    size: int = 0
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    fps_str: str | None = None
    vcodec: str | None = None
    acodec: str | None = None
    channels: int | None = None
    sample_rate: int | None = None
    rotation: int = 0
    has_video: bool = False
    has_audio: bool = False
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def res(self) -> str:
        return f"{self.width}x{self.height}" if self.width and self.height else "-"


def _fraction(s: str | None) -> float | None:
    if not s or s in ("0/0", "N/A"):
        return None
    try:
        if "/" in s:
            a, b = s.split("/", 1)
            return float(a) / float(b) if float(b) else None
        return float(s)
    except ValueError:
        return None


def probe(path: str | Path) -> MediaInfo:
    info = MediaInfo(path=str(path))
    code, out, err = run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format",
                          "-show_streams", str(path)], timeout=120)
    if code != 0:
        info.error = (err.strip().splitlines() or ["ffprobe failed"])[-1][:200]
        return info
    try:
        data = json.loads(out or "{}")
    except json.JSONDecodeError:
        info.error = "bad ffprobe json"
        return info
    fmt = data.get("format", {})
    info.duration = float(fmt.get("duration") or 0) if fmt.get("duration") not in (None, "N/A") else 0.0
    info.size = int(fmt.get("size") or 0) if str(fmt.get("size", "")).isdigit() else 0
    for st in data.get("streams", []):
        kind = st.get("codec_type")
        if kind == "video" and not info.has_video:
            if (st.get("disposition") or {}).get("attached_pic"):
                continue  # cover art in audio files
            info.has_video = True
            info.vcodec = st.get("codec_name")
            info.width, info.height = st.get("width"), st.get("height")
            rate = st.get("avg_frame_rate") if _fraction(st.get("avg_frame_rate")) else st.get("r_frame_rate")
            info.fps = _fraction(rate)
            info.fps_str = rate if info.fps else None
            rot = 0
            for sd in st.get("side_data_list") or []:
                if "rotation" in sd:
                    try:
                        rot = int(float(sd["rotation"]))
                    except (TypeError, ValueError):
                        pass
            if not rot and (st.get("tags") or {}).get("rotate"):
                try:
                    rot = int((st.get("tags") or {})["rotate"])
                except ValueError:
                    pass
            info.rotation = rot
            if abs(rot) % 180 == 90 and info.width and info.height:
                info.width, info.height = info.height, info.width  # display orientation
            if not info.duration and st.get("duration") not in (None, "N/A"):
                info.duration = float(st["duration"])
        elif kind == "audio" and not info.has_audio:
            info.has_audio = True
            info.acodec = st.get("codec_name")
            info.channels = st.get("channels")
            try:
                info.sample_rate = int(st.get("sample_rate") or 0) or None
            except ValueError:
                info.sample_rate = None
            if not info.duration and st.get("duration") not in (None, "N/A"):
                info.duration = float(st["duration"])
    if not info.size:
        try:
            info.size = Path(path).stat().st_size
        except OSError:
            pass
    return info


# ---------------------------------------------------------------- detectors

_PTS_RE = re.compile(r"pts_time:([0-9.]+)")
_SCORE_RE = re.compile(r"lavfi\.scene_score=([0-9.]+)")


def detect_scenes(path: str | Path, threshold: float = 0.3, scale_w: int = 320) -> list[tuple[float, float]]:
    """Scene cuts as (time, score) using ffmpeg's scene score on a downscaled stream."""
    vf = f"scale={scale_w}:-2,select='gt(scene,{threshold})',metadata=print:file=-"
    code, out, err = run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-an", "-sn", "-dn",
                          "-vf", vf, "-f", "null", "-"])
    if code != 0:
        raise MediaError(_last_err(err))
    cuts: list[tuple[float, float]] = []
    t = None
    for line in out.splitlines():
        m = _PTS_RE.search(line)
        if m:
            t = float(m.group(1))
            continue
        m = _SCORE_RE.search(line)
        if m and t is not None:
            cuts.append((round(t, 3), round(float(m.group(1)), 3)))
            t = None
    return cuts


_SIL_START = re.compile(r"silence_start:\s*(-?[0-9.]+)")
_SIL_END = re.compile(r"silence_end:\s*([0-9.]+)")


def detect_silence(path: str | Path, noise_db: float = -30.0, min_dur: float = 0.5,
                   duration: float | None = None) -> list[tuple[float, float]]:
    af = f"silencedetect=noise={noise_db}dB:d={min_dur}"
    code, out, err = run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-sn", "-dn",
                          "-af", af, "-f", "null", "-"])
    if code != 0:
        raise MediaError(_last_err(err))
    sil: list[tuple[float, float]] = []
    start = None
    for line in err.splitlines():
        m = _SIL_START.search(line)
        if m:
            start = max(0.0, float(m.group(1)))
            continue
        m = _SIL_END.search(line)
        if m and start is not None:
            sil.append((round(start, 3), round(float(m.group(1)), 3)))
            start = None
    if start is not None:
        end = duration if duration else probe(path).duration
        sil.append((round(start, 3), round(end, 3)))
    return sil


def speech_from_silence(silences: list[tuple[float, float]], duration: float, min_len: float = 0.3) -> list[tuple[float, float]]:
    out, cur = [], 0.0
    for s, e in silences:
        if s - cur >= min_len:
            out.append((round(cur, 3), round(s, 3)))
        cur = max(cur, e)
    if duration - cur >= min_len:
        out.append((round(cur, 3), round(duration, 3)))
    return out


_EBU_LINE = re.compile(r"\bt:\s*([0-9.]+)\s.*?\bM:\s*(-?[0-9.]+|-inf)\s+S:\s*(-?[0-9.]+|-inf)")
_EBU_I = re.compile(r"I:\s*(-?[0-9.]+|-inf)\s*LUFS")
_EBU_LRA = re.compile(r"LRA:\s*([0-9.]+)\s*LU")
_EBU_PEAK = re.compile(r"Peak:\s*(-?[0-9.]+|-inf)\s*dBFS")


def loudness(path: str | Path) -> dict:
    """EBU R128: integrated LUFS, LRA, true peak + short-term curve sampled at 10 Hz."""
    code, out, err = run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-sn", "-dn",
                          "-af", "ebur128=peak=true", "-f", "null", "-"])
    if code != 0:
        raise MediaError(_last_err(err))
    curve: list[tuple[float, float]] = []
    summary_at = err.rfind("Summary:")
    body = err[:summary_at] if summary_at >= 0 else err
    for line in body.splitlines():
        m = _EBU_LINE.search(line)
        if m:
            s = m.group(3)
            curve.append((float(m.group(1)), -120.0 if s == "-inf" else float(s)))
    summ = err[summary_at:] if summary_at >= 0 else ""

    def _num(rx: re.Pattern[str]) -> float | None:
        m = rx.search(summ)
        if not m:
            return None
        return None if m.group(1) == "-inf" else float(m.group(1))

    return {"integrated_lufs": _num(_EBU_I), "lra": _num(_EBU_LRA), "true_peak_db": _num(_EBU_PEAK),
            "short_term": curve}


def loudnorm_measure(path: str | Path, target_i: float = -14.0, tp: float = -1.5, lra: float = 11.0,
                     ss: float | None = None, t: float | None = None) -> dict | None:
    """First pass of two-pass loudnorm. Returns measured values or None (silent/no audio)."""
    cmd = [FFMPEG, "-hide_banner", "-nostats"]
    if ss is not None:
        cmd += ["-ss", f"{ss:.3f}"]
    if t is not None:
        cmd += ["-t", f"{t:.3f}"]
    cmd += ["-i", str(path), "-vn", "-sn", "-dn", "-af",
            f"loudnorm=I={target_i}:TP={tp}:LRA={lra}:print_format=json", "-f", "null", "-"]
    code, out, err = run(cmd)
    if code != 0:
        return None
    start = err.rfind("{")
    end = err.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        data = json.loads(err[start:end + 1])
    except json.JSONDecodeError:
        return None
    if str(data.get("input_i", "")).startswith("-inf"):
        return None
    return data


def loudnorm_filter(measured: dict | None, target_i: float = -14.0, tp: float = -1.5, lra: float = 11.0) -> str:
    if not measured:
        return f"loudnorm=I={target_i}:TP={tp}:LRA={lra}"
    return (f"loudnorm=I={target_i}:TP={tp}:LRA={lra}:measured_I={measured['input_i']}:"
            f"measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}:"
            f"measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:linear=true")


# ---------------------------------------------------------------- encoders

HW_ENCODERS = {
    "nvenc": "h264_nvenc",
    "qsv": "h264_qsv",
    "amf": "h264_amf",
    "videotoolbox": "h264_videotoolbox",
}


def ffmpeg_version() -> str | None:
    code, out, _ = run([FFMPEG, "-hide_banner", "-version"], timeout=20)
    if code != 0:
        return None
    first = (out.splitlines() or [""])[0]
    m = re.search(r"version\s+(\S+)", first)
    return m.group(1) if m else first[:40]


def available_filters() -> set[str]:
    code, out, _ = run([FFMPEG, "-hide_banner", "-filters"], timeout=20)
    names = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and re.fullmatch(r"[TSC.|]{2,3}", parts[0]):
            names.add(parts[1])
    return names


def detect_hw_encoders(force: bool = False) -> list[str]:
    """Return working hardware H.264 encoders (tested with a tiny encode). Cached per ffmpeg version."""
    ver = ffmpeg_version() or "?"
    cache_path = assistant_home() / "cache" / "mtk-hw.json"
    cache = load_json(cache_path, {}) or {}
    if not force and cache.get("ffmpeg") == ver and isinstance(cache.get("working"), list):
        return cache["working"]
    code, out, _ = run([FFMPEG, "-hide_banner", "-encoders"], timeout=20)
    working = []
    for key, enc in HW_ENCODERS.items():
        if enc not in out:
            continue
        c, _, _ = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                       "color=c=black:s=256x256:d=0.2", "-c:v", enc, "-f", "null", "-"], timeout=60)
        if c == 0:
            working.append(key)
    try:
        save_json(cache_path, {"ffmpeg": ver, "working": working})
    except OSError:
        pass
    return working


def resolve_hw(choice: str) -> str:
    """'auto' -> best working hw encoder or 'cpu'."""
    if choice in ("none", "cpu", "off"):
        return "cpu"
    if choice != "auto":
        return choice
    working = detect_hw_encoders()
    for key in ("nvenc", "videotoolbox", "qsv", "amf"):
        if key in working:
            return key
    return "cpu"


def video_encoder_args(hw: str, crf: int) -> list[str]:
    if hw == "nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", str(crf + 2),
                "-b:v", "0", "-profile:v", "high", "-pix_fmt", "yuv420p"]
    if hw == "qsv":
        return ["-c:v", "h264_qsv", "-preset", "slower", "-global_quality", str(crf + 2), "-pix_fmt", "nv12"]
    if hw == "amf":
        return ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", str(crf),
                "-qp_p", str(crf + 2), "-qp_b", str(crf + 4), "-pix_fmt", "yuv420p"]
    if hw == "videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-q:v", "62", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-profile:v", "high", "-pix_fmt", "yuv420p"]


def _last_err(err: str) -> str:
    lines = [ln for ln in err.strip().splitlines() if ln.strip()]
    return (lines[-1] if lines else "ffmpeg failed")[:300]


def run_ffmpeg(args: list[str], cwd: str | Path | None = None) -> tuple[bool, str]:
    """Run ffmpeg quietly; return (ok, short error)."""
    cmd = [FFMPEG, "-hide_banner", "-nostats", "-loglevel", "error", "-y"] + args
    code, _, err = run(cmd, cwd=cwd)
    return code == 0, ("" if code == 0 else _last_err(err))
