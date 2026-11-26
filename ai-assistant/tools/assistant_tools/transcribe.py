"""Speech-to-text via faster-whisper (optional dependency). GPU if available, CPU fallback."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from .common import IS_WINDOWS, assistant_home, load_json
from .subs import Segment, Word, compact_lines, write_srt


class TranscribeUnavailable(RuntimeError):
    pass


def _prepare_cuda_dlls() -> None:
    """On Windows, make pip-installed CUDA libs (nvidia-cublas-cu12, nvidia-cudnn-cu12) loadable."""
    if not IS_WINDOWS:
        return
    try:
        import nvidia  # type: ignore  # namespace package from nvidia-* wheels
    except ImportError:
        return
    for base in list(getattr(nvidia, "__path__", [])):
        for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            d = Path(base) / sub / "bin"
            if d.is_dir():
                try:
                    os.add_dll_directory(str(d))  # type: ignore[attr-defined]
                except (OSError, AttributeError):
                    pass
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")


def cuda_devices() -> int:
    try:
        _prepare_cuda_dlls()
        import ctranslate2  # type: ignore
        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def plan_defaults() -> dict:
    """Whisper settings chosen by `assistant-setup plan` for this PC (if any)."""
    plan = load_json(assistant_home() / "plan.json", {}) or {}
    return plan.get("whisper", {}) if isinstance(plan, dict) else {}


def choose(model: str = "auto", device: str = "auto") -> tuple[str, str, str]:
    d = plan_defaults()
    if device == "auto":
        device = d.get("device") or ("cuda" if cuda_devices() > 0 else "cpu")
        if device == "cuda" and cuda_devices() == 0:
            device = "cpu"
    compute = "float16" if device == "cuda" else "int8"
    if model == "auto":
        model = d.get("model") or ("large-v3-turbo" if device == "cuda" or (os.cpu_count() or 2) >= 8 else "medium")
    return model, device, compute


class Transcriber:
    def __init__(self, model: str = "auto", device: str = "auto"):
        try:
            _prepare_cuda_dlls()
            from faster_whisper import WhisperModel  # type: ignore
        except ImportError as e:
            raise TranscribeUnavailable(
                "faster-whisper не встановлено. Встановіть: uv tool install --editable <ai-assistant>/tools "
                "--with faster-whisper (або запустіть інсталятор ще раз)") from e
        self.model_name, self.device, self.compute = choose(model, device)
        try:
            self.model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute)
        except Exception as e:  # GPU libs missing etc. -> CPU fallback
            if self.device != "cpu":
                self.device, self.compute = "cpu", "int8"
                self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
                self.fallback_reason = str(e)[:200]
            else:
                raise

    def transcribe(self, path: str | Path, language: str | None = None, words: bool = True) -> dict:
        t0 = time.time()
        segments, info = self.model.transcribe(
            str(path), language=language or None, vad_filter=True, word_timestamps=words, beam_size=5,
            condition_on_previous_text=False,
        )
        segs = []
        for s in segments:
            item = {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
            if words and getattr(s, "words", None):
                item["words"] = [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip(),
                                  "p": round(getattr(w, "probability", 0.0) or 0.0, 3)} for w in s.words]
            segs.append(item)
        return {
            "source": str(path), "language": info.language, "language_probability": round(info.language_probability, 3),
            "duration": round(getattr(info, "duration", 0.0) or 0.0, 3), "model": self.model_name,
            "device": self.device, "compute_type": self.compute, "elapsed_sec": round(time.time() - t0, 1),
            "segments": segs,
        }


def to_segments(data: dict) -> list[Segment]:
    out = []
    for s in data["segments"]:
        out.append(Segment(s["start"], s["end"], s["text"],
                           [Word(w["start"], w["end"], w["word"]) for w in s.get("words", [])]))
    return out


def write_outputs(data: dict, out_dir: Path, stem: str) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {"json": out_dir / f"{stem}.json", "srt": out_dir / f"{stem}.srt", "txt": out_dir / f"{stem}.txt"}
    paths["json"].write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    segs = to_segments(data)
    write_srt(segs, paths["srt"])
    paths["txt"].write_text("\n".join(compact_lines(segs)) + "\n", encoding="utf-8")
    return paths


def is_fresh(src: Path, json_out: Path) -> bool:
    try:
        return json_out.stat().st_mtime >= src.stat().st_mtime and json_out.stat().st_size > 0
    except OSError:
        return False
