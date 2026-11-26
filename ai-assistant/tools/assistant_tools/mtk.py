"""mtk — media toolkit for token-efficient video work.

Principle: heavy lifting runs locally (FFmpeg, Whisper). The model only sees compact text — tables,
transcripts, candidate lists — and at most one contact-sheet image. Originals are never modified:
outputs go to `_out/` (renders) and `_transcripts/` next to the source unless -o/--out-dir is given.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import statistics
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import media as M
from .common import (IMAGE_EXT, MEDIA_EXT, VIDEO_EXT, ff_filter_path, fmt_ts, fonts_dir, human_size,
                     iter_files, parse_ts, save_json, system_font)
from .subs import Segment, build_ass, read_transcript, text_in_range

# Platform presets. Duration limits change often — see skills/video-production/reference/platforms.md
PRESETS: dict[str, dict] = {
    "tiktok": {"w": 1080, "h": 1920, "crf": 20, "abr": "192k", "lufs": -14.0},
    "reels": {"w": 1080, "h": 1920, "crf": 20, "abr": "192k", "lufs": -14.0},
    "shorts": {"w": 1080, "h": 1920, "crf": 20, "abr": "192k", "lufs": -14.0},
    "youtube": {"w": 1920, "h": 1080, "crf": 18, "abr": "320k", "lufs": -14.0},
    "youtube4k": {"w": 3840, "h": 2160, "crf": 18, "abr": "320k", "lufs": -14.0},
    "square": {"w": 1080, "h": 1080, "crf": 20, "abr": "192k", "lufs": -14.0},
    "feed45": {"w": 1080, "h": 1350, "crf": 20, "abr": "192k", "lufs": -14.0},
    "master": {"w": None, "h": None, "crf": 0, "abr": None, "lufs": None, "prores": True},
}
ASPECTS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080), "4:5": (1080, 1350)}
OUT_DIRS = {"_out", "_transcripts", "_sheets", "_frames"}


def _default_out(src: Path, suffix: str, sub: str = "_out") -> Path:
    d = src.parent / sub
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{src.stem}{suffix}"


def _collect(paths: list[str], exts: set[str], recursive: bool = True) -> list[Path]:
    """Expand inputs; inside a given folder skip our own output subfolders (_out, _transcripts, ...),
    but keep them when the user points at such a folder explicitly."""
    out: list[Path] = []
    for root in paths:
        r = Path(root)
        for f in iter_files([r], exts, recursive=recursive):
            rel = f.relative_to(r).parts[:-1] if r.is_dir() else ()
            if not (set(rel) & OUT_DIRS):
                out.append(f)
    return out


# ======================================================================= analysis

def cmd_probe(a: argparse.Namespace) -> int:
    exts = MEDIA_EXT | (IMAGE_EXT if a.images else set())
    files = _collect(a.paths, exts)
    if not files:
        print("Медіафайлів не знайдено.")
        return 1
    with ThreadPoolExecutor(max_workers=8) as ex:
        infos = list(ex.map(M.probe, files))
    if a.json:
        print(json.dumps([i.to_dict() for i in infos], ensure_ascii=False))
        return 0
    if a.csv:
        with open(a.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(infos[0].to_dict().keys()))
            w.writeheader()
            for i in infos:
                w.writerow(i.to_dict())
    try:
        base = Path(os.path.commonpath([str(f.parent) for f in files]))
    except ValueError:
        base = None
    show = infos if (a.all or len(infos) <= a.limit) else infos[: a.limit]
    print(f"{'ФАЙЛ':42} {'ТРИВАЛ.':>8} {'РОЗДІЛЬН.':>10} {'FPS':>6} {'ВІДЕО':>6} {'АУДІО':>9} {'РОЗМІР':>8}")
    for i in show:
        name = str(Path(i.path).relative_to(base)) if base else Path(i.path).name
        name = name if len(name) <= 42 else "…" + name[-41:]
        if i.error:
            print(f"{name:42} ПОМИЛКА: {i.error[:60]}")
            continue
        aud = f"{i.acodec} {i.channels}ch" if i.has_audio else "-"
        fps = f"{i.fps:.2f}" if i.fps else "-"
        print(f"{name:42} {fmt_ts(i.duration):>8} {i.res:>10} {fps:>6} {(i.vcodec or '-')[:6]:>6} "
              f"{aud[:9]:>9} {human_size(i.size):>8}")
    if len(show) < len(infos):
        print(f"… ще {len(infos) - len(show)} файлів (повний список: --all або --csv FILE)")
    ok = [i for i in infos if not i.error]
    groups: dict[str, int] = {}
    for i in ok:
        groups[i.res] = groups.get(i.res, 0) + 1
    top = ", ".join(f"{k}×{v}" for k, v in sorted(groups.items(), key=lambda kv: -kv[1])[:5])
    errs = [Path(i.path).name for i in infos if i.error]
    print(f"РАЗОМ: {len(infos)} файлів, {fmt_ts(sum(i.duration for i in ok))}, "
          f"{human_size(sum(i.size for i in ok))} | {top or '-'} | помилок: {len(errs)}"
          + (f" ({', '.join(errs[:5])})" if errs else ""))
    return 0


def _tile_size(w: int, h: int, cols: int, rows: int, max_side: int) -> tuple[int, int]:
    pad = 4 * (cols + 1)
    tw = (max_side - pad) // cols
    th = int(tw * h / w)
    if th * rows + 4 * (rows + 1) > max_side:
        th = (max_side - 4 * (rows + 1)) // rows
        tw = int(th * w / h)
    return max(16, tw - tw % 2), max(16, th - th % 2)


def cmd_sheet(a: argparse.Namespace) -> int:
    src = Path(a.input)
    info = M.probe(src)
    if info.error or not info.has_video or not info.duration:
        print(f"Не вдалося прочитати відео: {info.error or 'немає відеопотоку/тривалості'}")
        return 1
    n = a.cols * a.rows
    times = [info.duration * (i + 0.5) / n for i in range(n)]
    if a.mode == "scenes":
        cuts = [t for t, _ in M.detect_scenes(src)]
        if len(cuts) >= n:
            step = len(cuts) / n
            times = [min(info.duration - 0.05, cuts[int(i * step)] + 0.3) for i in range(n)]
    tw, th = _tile_size(info.width or 16, info.height or 9, a.cols, a.rows, a.max_side)
    font = system_font() if "drawtext" in M.available_filters() else None
    out = Path(a.output) if a.output else _default_out(src, "_sheet.jpg", "_sheets")
    with tempfile.TemporaryDirectory() as td:
        for i, t in enumerate(times):
            frame = Path(td) / f"f_{i:03d}.jpg"
            vf = (f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
                  f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=black")
            if font:
                (Path(td) / f"t_{i:03d}.txt").write_text(f"{i + 1}  {fmt_ts(t)}", encoding="utf-8")
                vf += (f",drawtext=fontfile={ff_filter_path(font)}:textfile=t_{i:03d}.txt:x=4:y=4:"
                       f"fontsize={max(11, th // 11)}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3")
            ok, _ = M.run_ffmpeg(["-ss", f"{t:.3f}", "-i", str(src.resolve()), "-frames:v", "1", "-vf", vf,
                                  "-q:v", "3", frame.name], cwd=td)
            if not ok or not frame.exists():
                M.run_ffmpeg(["-f", "lavfi", "-i", f"color=c=black:s={tw}x{th}", "-frames:v", "1", frame.name], cwd=td)
        ok, err = M.run_ffmpeg(["-framerate", "1", "-i", "f_%03d.jpg", "-vf",
                                f"tile={a.cols}x{a.rows}:padding=4:margin=4:color=black", "-frames:v", "1",
                                "-q:v", "3", str(out.resolve())], cwd=td)
    if not ok:
        print(f"Помилка аркуша: {err}")
        return 1
    W, H = a.cols * tw + 4 * (a.cols + 1), a.rows * th + 4 * (a.rows + 1)
    print(f"Аркуш: {out} ({W}x{H}, ≈{W * H // 750} токенів при перегляді)")
    print("Кадри (зліва направо, згори вниз): " + ", ".join(f"{i + 1}@{fmt_ts(t)}" for i, t in enumerate(times)))
    return 0


def cmd_scenes(a: argparse.Namespace) -> int:
    cuts = M.detect_scenes(a.input, a.threshold)
    if a.json:
        save_json(Path(a.json), {"source": str(a.input), "threshold": a.threshold, "cuts": cuts})
    print(f"Змін сцен: {len(cuts)} (поріг {a.threshold})")
    if cuts:
        shown = cuts[: a.limit]
        print(", ".join(f"{fmt_ts(t)}({s:.2f})" for t, s in shown) + (" …" if len(cuts) > len(shown) else ""))
    return 0


def cmd_silence(a: argparse.Namespace) -> int:
    info = M.probe(a.input)
    sil = M.detect_silence(a.input, a.noise, a.min, info.duration)
    total = sum(e - s for s, e in sil)
    speech = M.speech_from_silence(sil, info.duration)
    if a.json:
        save_json(Path(a.json), {"source": str(a.input), "silences": sil, "speech": speech})
    ratio = (1 - total / info.duration) * 100 if info.duration else 0
    print(f"Тиша: {len(sil)} проміжків, {fmt_ts(total)} з {fmt_ts(info.duration)} | звук/мова: {ratio:.0f}%")
    if sil:
        shown = sil[: a.limit]
        print(", ".join(f"{fmt_ts(s)}–{fmt_ts(e)}" for s, e in shown) + (" …" if len(sil) > len(shown) else ""))
    return 0


def cmd_loudness(a: argparse.Namespace) -> int:
    r = M.loudness(a.input)
    curve = r["short_term"]
    print(f"Інтегральна гучність: {r['integrated_lufs']} LUFS | LRA: {r['lra']} LU | True peak: {r['true_peak_db']} dBFS")
    if curve:
        peaks: list[tuple[float, float]] = []
        for t, s in sorted(curve, key=lambda x: -x[1]):
            if all(abs(t - pt) > 5 for pt, _ in peaks):
                peaks.append((t, s))
            if len(peaks) >= a.top:
                break
        print("Найгучніші моменти (S, 3 с): " + ", ".join(f"{fmt_ts(t)} {s:.1f}" for t, s in sorted(peaks)))
    return 0


def cmd_transcribe(a: argparse.Namespace) -> int:
    from .transcribe import TranscribeUnavailable, Transcriber, is_fresh, write_outputs
    files = _collect(a.paths, MEDIA_EXT)
    if not files:
        print("Медіафайлів не знайдено.")
        return 1
    tr, done, skipped, failed = None, 0, 0, []
    for f in files:
        out_dir = Path(a.out_dir) if a.out_dir else f.parent / "_transcripts"
        if not a.force and is_fresh(f, out_dir / f"{f.stem}.json"):
            skipped += 1
            continue
        try:
            if tr is None:
                tr = Transcriber(a.model, a.device)
                fb = getattr(tr, "fallback_reason", None)
                print(f"Модель: {tr.model_name} ({tr.device}, {tr.compute})" + (f" — GPU недоступний: {fb}" if fb else ""))
            data = tr.transcribe(f, a.lang, words=not a.no_words)
            paths = write_outputs(data, out_dir, f.stem)
            done += 1
            print(f"OK {f.name}: мова={data['language']} ({data['language_probability']}), "
                  f"{fmt_ts(data['duration'])}, {len(data['segments'])} сегм., {data['elapsed_sec']} с → {paths['txt']}")
            if a.print and len(files) == 1:
                print(paths["txt"].read_text(encoding="utf-8"))
        except TranscribeUnavailable as e:
            print(str(e))
            return 3
        except Exception as e:  # keep batch going
            failed.append(f"{f.name}: {str(e)[:120]}")
    print(f"Готово: {done}, пропущено (вже є): {skipped}, помилок: {len(failed)}")
    for x in failed[:10]:
        print("  ✗", x)
    return 0 if not failed else 1


# ======================================================================= highlights

def _snap(s: float, e: float, segs: list[Segment] | None, speech: list[tuple[float, float]],
          min_len: float, max_len: float, dur: float) -> tuple[float, float]:
    starts = [x.start for x in segs] if segs else [x[0] for x in speech]
    ends = [x.end for x in segs] if segs else [x[1] for x in speech]
    cs = [t for t in starts if s - 3.0 <= t <= s + 0.5]
    ce = [t for t in ends if e - 0.5 <= t <= e + 4.0]
    s2 = max(cs) if cs else s
    e2 = min(ce) if ce else e
    if e2 - s2 < min_len:
        e2 = s2 + min_len
    if e2 - s2 > max_len:
        e2 = s2 + max_len
    return max(0.0, s2), min(dur, e2)


def compute_highlights(path: str | Path, segs: list[Segment] | None = None, target: float = 15.0, top: int = 8,
                       min_len: float = 5.0, max_len: float = 30.0, keywords: tuple[str, ...] = ()) -> list[dict]:
    info = M.probe(path)
    dur = info.duration
    n = max(1, int(math.ceil(dur)))
    loud = [-70.0] * n
    speech_iv: list[tuple[float, float]] = []
    if info.has_audio:
        buckets: list[list[float]] = [[] for _ in range(n)]
        for t, s in M.loudness(path)["short_term"]:
            buckets[min(n - 1, int(t))].append(max(s, -70.0))
        loud = [sum(b) / len(b) if b else -70.0 for b in buckets]
        if not segs:
            speech_iv = M.speech_from_silence(M.detect_silence(path, duration=dur), dur)
    cut_sec = [0] * n
    if info.has_video:
        for t, _ in M.detect_scenes(path):
            cut_sec[min(n - 1, int(t))] += 1
    speech = [0.0] * n
    ivs = [(x.start, x.end) for x in segs] if segs else speech_iv
    for s0, e0 in ivs:
        for i in range(int(s0), min(n, int(math.ceil(e0)))):
            speech[i] = 1.0
    kw = [0] * n
    if keywords and segs:
        for x in segs:
            low = x.text.lower()
            kw[min(n - 1, int(x.start))] += sum(low.count(k.lower()) for k in keywords if k)
    valid = [x for x in loud if x > -69]
    med = statistics.median(valid) if valid else -70.0
    sd = (statistics.pstdev(valid) if len(valid) > 1 else 1.0) or 1.0
    L = max(1, min(n, int(round(target))))
    cands = []
    for s in range(0, n - L + 1):
        w = slice(s, s + L)
        lz = (sum(loud[w]) / L - med) / sd
        pk = (max(loud[w]) - med) / sd
        sc = sum(cut_sec[w]) / L * 10
        sp = sum(speech[w]) / L
        k = sum(kw[w])
        score = lz + 0.5 * pk + 0.3 * min(sc, 3) + 0.6 * sp + 1.0 * min(k, 3)
        cands.append((score, s, s + L, lz, sc, sp, k))
    cands.sort(key=lambda c: -c[0])
    chosen: list[tuple] = []
    for c in cands:
        if all(c[1] >= ch[2] + 2 or c[2] <= ch[1] - 2 for ch in chosen):
            chosen.append(c)
        if len(chosen) >= top:
            break
    out = []
    for score, s, e, lz, sc, sp, k in chosen:
        s2, e2 = _snap(float(s), float(e), segs, speech_iv, min_len, max_len, dur)
        reasons = []
        if lz > 0.5:
            reasons.append(f"гучніше за середнє (z={lz:.1f})")
        if sc >= 1:
            reasons.append(f"динамічний монтаж ({sc:.1f} змін/10с)")
        if sp >= 0.7:
            reasons.append("щільна мова")
        if k:
            reasons.append(f"ключові слова ×{k}")
        out.append({"start": round(s2, 2), "end": round(e2, 2), "score": round(score, 2),
                    "reasons": ", ".join(reasons) or "загальний бал",
                    "text": text_in_range(segs, s2, e2)[:160] if segs else ""})
    return out


def _find_transcript(src: Path, explicit: str | None) -> Path | None:
    if explicit:
        return Path(explicit)
    for cand in (src.parent / "_transcripts" / f"{src.stem}.json", src.with_suffix(".json"), src.with_suffix(".srt")):
        if cand.exists():
            return cand
    return None


def cmd_highlights(a: argparse.Namespace) -> int:
    src = Path(a.input)
    tp = _find_transcript(src, a.transcript)
    segs = read_transcript(tp) if tp else None
    kws = tuple(k.strip() for k in (a.keywords or "").split(",") if k.strip())
    res = compute_highlights(src, segs, a.target, a.top, a.min, a.max, kws)
    out = Path(a.output) if a.output else _default_out(src, "_highlights.json")
    save_json(out, {"source": str(src.resolve()), "transcript": str(tp) if tp else None, "segments": res})
    print(f"Кандидати ({len(res)}) — евристика: гучність, зміни сцен, мова{', ключові слова' if kws else ''}"
          f"{'' if segs else ' (без транскрипту: спершу mtk transcribe)'} → {out}")
    for i, r in enumerate(res, 1):
        txt = f" | «{r['text'][:90]}»" if r["text"] else ""
        print(f"{i:2}. {fmt_ts(r['start'])}–{fmt_ts(r['end'])} ({r['end'] - r['start']:.0f}с) бал {r['score']:.1f}: "
              f"{r['reasons']}{txt}")
    return 0


# ======================================================================= editing

def _load_segments(spec: str | None, file: str | None) -> list[tuple[float, float]]:
    segs: list[tuple[float, float]] = []
    if spec:
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
            a, b = part.split("-", 1)
            segs.append((parse_ts(a), parse_ts(b)))
    if file:
        data = json.loads(Path(file).read_text(encoding="utf-8"))
        items = data.get("segments", data) if isinstance(data, dict) else data
        for it in items:
            if isinstance(it, dict):
                segs.append((parse_ts(it["start"]), parse_ts(it["end"])))
            else:
                segs.append((parse_ts(it[0]), parse_ts(it[1])))
    return segs


def _encode(args_wo_codecs: list[str], out: Path, hw: str, crf: int, abr: str | None, has_audio: bool,
            prores: bool = False, cwd: str | None = None) -> tuple[bool, str, str]:
    """Run ffmpeg with encoder settings; retry on CPU if the hardware encoder fails."""
    def build(h: str) -> list[str]:
        if prores:
            v = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
            aud = ["-c:a", "pcm_s16le", "-ar", "48000"] if has_audio else []
        else:
            v = M.video_encoder_args(h, crf)
            aud = ["-c:a", "aac", "-b:a", abr or "192k", "-ar", "48000", "-ac", "2"] if has_audio else []
        tail = [] if prores else ["-movflags", "+faststart"]
        return args_wo_codecs + v + aud + tail + [str(out.resolve())]
    ok, err = M.run_ffmpeg(build(hw), cwd=cwd)
    if not ok and hw != "cpu" and not prores:
        ok, err = M.run_ffmpeg(build("cpu"), cwd=cwd)
        hw = "cpu" if ok else hw
    return ok, err, hw


def cmd_cut(a: argparse.Namespace) -> int:
    src = Path(a.input)
    info = M.probe(src)
    if info.error or not info.has_video:
        print(f"Не вдалося прочитати відео: {info.error or 'немає відео'}")
        return 1
    segs = _load_segments(a.segments, a.segments_file)
    segs = [(max(0.0, s), min(info.duration, e)) for s, e in segs if e > s]
    if not segs:
        print("Немає сегментів (--segments '0:10-0:20,1:05-1:12' або --segments-file).")
        return 2
    d = a.tdur if a.transition else 0.0
    if a.transition and any(e - s <= d + 0.05 for s, e in segs):
        print(f"Сегменти мають бути довші за перехід ({d} с).")
        return 2
    out = Path(a.output) if a.output else _default_out(src, "_cut.mp4")
    ins: list[str] = []
    for s, e in segs:
        ins += ["-ss", f"{s:.3f}", "-t", f"{e - s:.3f}", "-i", str(src.resolve())]
    fps = info.fps_str or "30"
    fc = []
    for i in range(len(segs)):
        fc.append(f"[{i}:v:0]setpts=PTS-STARTPTS,fps={fps},format=yuv420p,setsar=1[v{i}]")
        if info.has_audio:
            fc.append(f"[{i}:a:0]asetpts=PTS-STARTPTS,aresample=48000[a{i}]")
    if a.transition and len(segs) > 1:
        lens = [e - s for s, e in segs]
        off = lens[0] - d
        pv, pa = "v0", "a0"
        for i in range(1, len(segs)):
            fc.append(f"[{pv}][v{i}]xfade=transition={a.transition}:duration={d}:offset={off:.3f}[vx{i}]")
            if info.has_audio:
                fc.append(f"[{pa}][a{i}]acrossfade=d={d}[ax{i}]")
                pa = f"ax{i}"
            pv = f"vx{i}"
            off += lens[i] - d
        vmap, amap = f"[{pv}]", f"[{pa}]"
    else:
        streams = "".join(f"[v{i}]" + (f"[a{i}]" if info.has_audio else "") for i in range(len(segs)))
        fc.append(f"{streams}concat=n={len(segs)}:v=1:a={1 if info.has_audio else 0}[vc]" + ("[ac]" if info.has_audio else ""))
        vmap, amap = "[vc]", "[ac]"
    args = ins + ["-filter_complex", ";".join(fc), "-map", vmap] + (["-map", amap] if info.has_audio else [])
    hw = M.resolve_hw(a.hw)
    ok, err, used = _encode(args, out, hw, 18, "192k", info.has_audio)
    if not ok:
        print(f"Помилка нарізки: {err}")
        return 1
    total = sum(e - s for s, e in segs) - d * (len(segs) - 1)
    print(f"OK: {out} — {len(segs)} сегм., ≈{fmt_ts(total)}, кодек {used}")
    return 0


def _dims(preset: dict, aspect: str | None, info: M.MediaInfo) -> tuple[int | None, int | None]:
    if aspect:
        if aspect not in ASPECTS:
            raise ValueError(f"aspect: {', '.join(ASPECTS)}")
        w, h = ASPECTS[aspect]
        if preset.get("w") == 3840:
            w, h = w * 2, h * 2
        return w, h
    return preset.get("w"), preset.get("h")


def _parse_trim(trim: str | None, dur: float) -> tuple[float, float]:
    if not trim:
        return 0.0, dur
    a, b = trim.split("-", 1)
    s, e = parse_ts(a), (parse_ts(b) if b.strip() else dur)
    return max(0.0, s), min(dur, e)


def render_one(src: Path, o: dict) -> dict:
    """Compose trim → LUT → reframe → logo → subtitles/title → platform encode (+2-pass loudnorm). One encode."""
    t0 = time.time()
    info = M.probe(src)
    if info.error or not info.has_video:
        return {"file": src.name, "status": "fail", "msg": info.error or "немає відеопотоку"}
    preset_name = o.get("preset") or "youtube"
    p = PRESETS[preset_name]
    W, H = _dims(p, o.get("aspect"), info)
    start, end = _parse_trim(o.get("trim"), info.duration)
    clip = end - start
    ext = ".mov" if p.get("prores") else ".mp4"
    out_dir = Path(o["out_dir"]) if o.get("out_dir") else src.parent / "_out"
    out = Path(o["output"]) if o.get("output") else out_dir / f"{src.stem}_{preset_name}{ext}"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and not o.get("overwrite"):
        return {"file": src.name, "status": "skip", "out": str(out), "msg": "вже існує"}
    if out.resolve() == src.resolve():
        return {"file": src.name, "status": "fail", "msg": "вихід збігається з оригіналом"}

    # --- subtitles / title
    segs: list[Segment] | None = None
    ass_text: str | None = None
    subs = o.get("subs") or "none"
    style = o.get("style") or "tiktok"
    fw, fh = (W or info.width or 1920), (H or info.height or 1080)
    if subs != "none":
        tp = _find_transcript(src, None if subs == "auto" else subs)
        if tp and tp.suffix.lower() == ".ass":
            ass_text = tp.read_text(encoding="utf-8")
        elif tp:
            segs = read_transcript(tp)
        elif subs == "auto":
            from .transcribe import Transcriber, write_outputs
            tr = o.get("_transcriber") or Transcriber()
            o["_transcriber"] = tr
            data = tr.transcribe(src, o.get("lang"))
            write_outputs(data, src.parent / "_transcripts", src.stem)
            segs = read_transcript(src.parent / "_transcripts" / f"{src.stem}.json")
        else:
            return {"file": src.name, "status": "fail", "msg": f"субтитри не знайдено: {subs}"}
    if (segs or o.get("title")) and ass_text is None:
        ass_text = build_ass(fw, fh, segs or [], style if segs else "none", offset=start, clip_duration=clip,
                             title=o.get("title"), title_dur=float(o.get("title_dur") or 3.0),
                             uppercase=o.get("uppercase"))

    # --- video graph
    pre = []
    if o.get("lut"):
        pre.append(f"lut3d=file={ff_filter_path(Path(o['lut']).resolve())}")
    if o.get("fps"):
        pre.append(f"fps={o['fps']}")
    elif info.fps and info.fps > 60.5:
        pre.append("fps=60")
    head = "[0:v]" + (",".join(pre) + "," if pre else "")
    fc: list[str] = []
    fit = o.get("fit") or "auto"
    if W and H and info.width and info.height:
        same = abs((info.width / info.height) - (W / H)) < 0.01
        if fit == "auto":
            fit = "scale" if same else "blur"
        if fit == "blur":
            bw, bh = max(2, W // 4 - (W // 4) % 2), max(2, H // 4 - (H // 4) % 2)
            fc.append(f"{head}split=2[bgs][fgs]")
            fc.append(f"[bgs]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=10:2,"
                      f"scale={W}:{H},setsar=1[bg]")
            fc.append(f"[fgs]scale={W}:{H}:force_original_aspect_ratio=decrease,setsar=1[fg]")
            fc.append("[bg][fg]overlay=(W-w)/2:(H-h)/2[v1]")
        elif fit == "crop":
            cx = min(1.0, max(0.0, float(o.get("crop_x", 0.5))))
            fc.append(f"{head}scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}:(iw-{W})*{cx}:(ih-{H})/2,setsar=1[v1]")
        elif fit == "pad":
            fc.append(f"{head}scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v1]")
        else:
            fc.append(f"{head}scale={W}:{H},setsar=1[v1]")
    else:
        fc.append(f"{head}null[v1]" if pre else "[0:v]null[v1]")
    cur = "[v1]"
    inputs: list[str] = []
    if start > 0:
        inputs += ["-ss", f"{start:.3f}"]
    if o.get("trim"):
        inputs += ["-t", f"{clip:.3f}"]
    inputs += ["-i", str(src.resolve())]
    if o.get("logo"):
        inputs += ["-i", str(Path(o["logo"]).resolve())]
        lw = max(16, int(fw * float(o.get("logo_scale") or 0.15)))
        m = int(min(fw, fh) * 0.04)
        pos = {"tr": f"W-w-{m}:{m}", "tl": f"{m}:{m}", "br": f"W-w-{m}:H-h-{m}", "bl": f"{m}:H-h-{m}"}[o.get("logo_pos") or "tr"]
        op = float(o.get("logo_opacity") or 0.9)
        fc.append(f"[1:v]format=rgba,scale={lw}:-1,colorchannelmixer=aa={op}[lg]")
        fc.append(f"{cur}[lg]overlay={pos}[v2]")
        cur = "[v2]"
    with tempfile.TemporaryDirectory() as td:
        if ass_text:
            (Path(td) / "subs.ass").write_text(ass_text, encoding="utf-8")
            fdir = fonts_dir()
            fd_opt = f":fontsdir={ff_filter_path(fdir)}" if fdir else ""
            fc.append(f"{cur}subtitles=filename=subs.ass{fd_opt}[v3]")
            cur = "[v3]"
        fc.append(f"{cur}format={'yuv422p10le' if p.get('prores') else 'yuv420p'}[vout]")
        # --- audio graph
        if info.has_audio:
            af = "aresample=48000"
            lufs = p.get("lufs")
            if lufs is not None and o.get("loudnorm", True):
                meas = M.loudnorm_measure(src, lufs, ss=start if start > 0 else None, t=clip if o.get("trim") else None)
                af = M.loudnorm_filter(meas, lufs) + ",aresample=48000" if meas else af
            fc.append(f"[0:a:0]{af}[aout]")
        args = inputs + ["-filter_complex", ";".join(fc), "-map", "[vout]"] + (["-map", "[aout]"] if info.has_audio else [])
        if o.get("dry_run"):
            return {"file": src.name, "status": "dry-run", "out": str(out), "msg": " ".join(args)}
        hw = M.resolve_hw(o.get("hw") or "auto")
        ok, err, used = _encode(args, out, hw, int(o.get("crf") or p["crf"] or 18), p.get("abr"), info.has_audio,
                                prores=bool(p.get("prores")), cwd=td)
    if not ok:
        return {"file": src.name, "status": "fail", "msg": err}
    return {"file": src.name, "status": "ok", "out": str(out), "sec": round(time.time() - t0, 1), "encoder": used,
            "msg": f"{W or info.width}x{H or info.height}, {fmt_ts(clip)}"}


def _render_opts(a: argparse.Namespace) -> dict:
    return {k: getattr(a, k, None) for k in ("preset", "aspect", "fit", "crop_x", "trim", "lut", "subs", "style",
                                             "lang", "title", "title_dur", "logo", "logo_pos", "logo_scale",
                                             "logo_opacity", "hw", "crf", "fps", "out_dir", "output", "overwrite",
                                             "dry_run", "uppercase")} | {"loudnorm": not getattr(a, "no_loudnorm", False)}


def cmd_render(a: argparse.Namespace) -> int:
    r = render_one(Path(a.input), _render_opts(a))
    if r["status"] == "dry-run":
        print("ffmpeg " + r["msg"])
        return 0
    print(f"{r['status'].upper()}: {r.get('out', r['file'])} — {r.get('msg', '')}"
          + (f" [{r.get('encoder')}, {r.get('sec')} с]" if r["status"] == "ok" else ""))
    return 0 if r["status"] in ("ok", "skip") else 1


def cmd_batch(a: argparse.Namespace) -> int:
    out_dir = Path(a.out_dir) if a.out_dir else Path(a.input_dir) / "_out"
    out_res = out_dir.resolve()
    files = _collect([a.input_dir], VIDEO_EXT, recursive=not a.no_recursive)
    files = [f for f in files if out_res not in f.resolve().parents]  # never re-process our own outputs
    if a.pattern:
        import fnmatch
        files = [f for f in files if fnmatch.fnmatch(f.name.lower(), a.pattern.lower())]
    if not files:
        print("Відеофайлів не знайдено.")
        return 1
    opts = _render_opts(a)
    opts["output"] = None
    out_dir.mkdir(parents=True, exist_ok=True)
    opts["out_dir"] = str(out_dir)
    log = out_dir / "_batch_log.jsonl"
    progress = out_dir / "_batch_progress.txt"
    t0 = time.time()
    if a.subs == "auto":  # transcribe first, sequentially (one model load), then render in parallel
        from .transcribe import TranscribeUnavailable, Transcriber, is_fresh, write_outputs
        todo = [f for f in files if not is_fresh(f, f.parent / "_transcripts" / f"{f.stem}.json")]
        if todo:
            try:
                tr = Transcriber(a.model if hasattr(a, "model") else "auto")
            except TranscribeUnavailable as e:
                print(str(e))
                return 3
            for i, f in enumerate(todo, 1):
                progress.write_text(f"транскрипція {i}/{len(todo)}: {f.name}\n", encoding="utf-8")
                write_outputs(tr.transcribe(f, a.lang), f.parent / "_transcripts", f.stem)
    results: list[dict] = []
    done = 0

    def job(f: Path) -> dict:
        nonlocal done
        try:
            r = render_one(f, dict(opts))
        except Exception as e:
            r = {"file": f.name, "status": "fail", "msg": str(e)[:200]}
        done += 1
        progress.write_text(f"рендер {done}/{len(files)}\n", encoding="utf-8")
        return r

    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        results = list(ex.map(job, files))
    with open(log, "a", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    ok = [r for r in results if r["status"] == "ok"]
    sk = [r for r in results if r["status"] == "skip"]
    bad = [r for r in results if r["status"] == "fail"]
    progress.write_text(f"готово: {len(ok)} ok, {len(sk)} пропущено, {len(bad)} помилок\n", encoding="utf-8")
    print(f"Пакет: {len(files)} файлів за {fmt_ts(time.time() - t0)} → {out_dir}")
    print(f"  готово: {len(ok)}, пропущено (вже є): {len(sk)}, помилок: {len(bad)} | журнал: {log}")
    for r in bad[:10]:
        print(f"  ✗ {r['file']}: {r.get('msg', '')[:150]}")
    return 0 if not bad else 1


# ======================================================================= timeline / frames

def _rt(v: float, rate: float) -> dict:
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": rate, "value": float(v)}


def _tr(start: float, dur: float, rate: float) -> dict:
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(start, rate), "duration": _rt(dur, rate)}


def build_otio(src: Path, segs: list[tuple[float, float]], rate: float, src_dur: float, name: str,
               dissolve: float = 0.0, with_audio: bool = True) -> dict:
    def clip(s: float, e: float) -> dict:
        return {
            "OTIO_SCHEMA": "Clip.2", "metadata": {}, "name": f"{src.name} @{fmt_ts(s)}",
            "source_range": _tr(round(s * rate), round((e - s) * rate), rate),
            "effects": [], "markers": [], "enabled": True,
            "media_references": {"DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1", "metadata": {}, "name": src.name,
                "available_range": _tr(0, round(src_dur * rate), rate), "available_image_bounds": None,
                "target_url": src.resolve().as_uri()}},
            "active_media_reference_key": "DEFAULT_MEDIA",
        }

    def track(kind: str, label: str) -> dict:
        children: list[dict] = []
        for i, (s, e) in enumerate(segs):
            if i and dissolve > 0:
                half = round(dissolve * rate / 2)
                children.append({"OTIO_SCHEMA": "Transition.1", "metadata": {}, "name": "",
                                 "in_offset": _rt(half, rate), "out_offset": _rt(half, rate),
                                 "transition_type": "SMPTE_Dissolve"})
            children.append(clip(s, e))
        return {"OTIO_SCHEMA": "Track.1", "metadata": {}, "name": label, "source_range": None, "effects": [],
                "markers": [], "enabled": True, "children": children, "kind": kind}

    tracks = [track("Video", "V1")] + ([track("Audio", "A1")] if with_audio else [])
    return {"OTIO_SCHEMA": "Timeline.1", "metadata": {}, "name": name, "global_start_time": _rt(3600 * rate, rate),
            "tracks": {"OTIO_SCHEMA": "Stack.1", "metadata": {}, "name": "tracks", "source_range": None,
                       "effects": [], "markers": [], "enabled": True, "children": tracks}}


def _tc(sec: float, fps: int) -> str:
    f = int(round(sec * fps))
    h, f = divmod(f, 3600 * fps)
    m, f = divmod(f, 60 * fps)
    s, f = divmod(f, fps)
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def build_edl(src: Path, segs: list[tuple[float, float]], fps: int, name: str) -> str:
    lines = [f"TITLE: {name}", "FCM: NON-DROP FRAME", ""]
    rec = 3600.0
    for i, (s, e) in enumerate(segs, 1):
        d = e - s
        lines.append(f"{i:03d}  AX       AA/V  C        {_tc(s, fps)} {_tc(e, fps)} {_tc(rec, fps)} {_tc(rec + d, fps)}")
        lines.append(f"* FROM CLIP NAME: {src.name}")
        lines.append("")
        rec += d
    return "\n".join(lines)


def cmd_timeline(a: argparse.Namespace) -> int:
    src = Path(a.source)
    info = M.probe(src)
    segs = _load_segments(a.segments, a.segments_file)
    if not segs or info.error:
        print(f"Потрібні сегменти і читабельне джерело ({info.error or 'немає сегментів'}).")
        return 2
    rate = float(a.fps or round(info.fps or 25.0, 3))
    name = a.name or f"{src.stem} edit"
    out = Path(a.output) if a.output else _default_out(src, "_edit.otio")
    save_json(out, build_otio(src, segs, rate, info.duration, name, a.dissolve, info.has_audio))
    msg = f"OTIO: {out}"
    if a.edl:
        edl = out.with_suffix(".edl")
        edl.write_text(build_edl(src, segs, int(round(rate)), name), encoding="utf-8")
        msg += f" | EDL: {edl}"
    print(msg + f" — {len(segs)} кліпів, {rate} fps. Імпорт: Resolve → File → Import → Timeline, "
                f"або `mtk resolve import-timeline {out.name}`")
    return 0


def cmd_frames(a: argparse.Namespace) -> int:
    src = Path(a.input)
    out_dir = Path(a.out_dir) if a.out_dir else src.parent / "_frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for t in [parse_ts(x) for x in a.at.split(",") if x.strip()]:
        p = out_dir / f"{src.stem}_{int(t * 1000):09d}.jpg"
        ok, err = M.run_ffmpeg(["-ss", f"{t:.3f}", "-i", str(src.resolve()), "-frames:v", "1", "-vf",
                                f"scale={a.width}:-2", "-q:v", "3", str(p.resolve())])
        paths.append(str(p) if ok else f"помилка @{fmt_ts(t)}: {err}")
    print("\n".join(paths))
    return 0


# ======================================================================= doctor / resolve

def cmd_doctor(a: argparse.Namespace) -> int:
    from .common import which
    ver = M.ffmpeg_version()
    print(f"ffmpeg: {ver or 'НЕ ЗНАЙДЕНО'} | ffprobe: {'так' if which(M.FFPROBE) else 'НЕ ЗНАЙДЕНО'}")
    if not ver:
        return 3
    need = ["subtitles", "drawtext", "lut3d", "xfade", "loudnorm", "ebur128", "silencedetect", "boxblur"]
    have = M.available_filters()
    miss = [f for f in need if f not in have]
    print("фільтри: " + ("усі потрібні є" if not miss else "бракує " + ", ".join(miss)))
    hw = M.detect_hw_encoders(force=True)
    print(f"апаратні кодери: {', '.join(hw) if hw else 'немає (кодування на CPU, libx264)'}")
    try:
        import faster_whisper  # type: ignore
        from .transcribe import choose, cuda_devices
        m, d, c = choose()
        print(f"faster-whisper {getattr(faster_whisper, '__version__', '?')}: CUDA-пристроїв {cuda_devices()}, "
              f"за замовчуванням {m} ({d}, {c})")
    except ImportError:
        print("faster-whisper: не встановлено (транскрипція недоступна)")
    for tool in ("auto-editor",):
        print(f"{tool}: {'є' if which(tool) else 'немає'}")
    from .resolve_bridge import script_paths
    api, lib = script_paths()
    print(f"DaVinci Resolve scripting: {'знайдено' if Path(lib).exists() else 'не знайдено'} ({lib})")
    return 0


def cmd_resolve(a: argparse.Namespace) -> int:
    from . import resolve_bridge as R
    try:
        if a.rcmd == "info":
            for k, v in R.info().items():
                print(f"{k}: {v}")
        elif a.rcmd == "presets":
            print("\n".join(R.presets()))
        elif a.rcmd == "import-media":
            print(f"Імпортовано: {R.import_media(a.paths, a.bin)}")
        elif a.rcmd == "import-timeline":
            print(f"Таймлайн: {R.import_timeline(a.file, a.name)}")
        elif a.rcmd == "markers":
            data = json.loads(Path(a.file).read_text(encoding="utf-8"))
            print(f"Маркерів додано: {R.add_markers(data.get('segments', data), a.color)}")
        elif a.rcmd == "render":
            for j in R.render(a.preset, a.timelines, a.target_dir, wait=not a.no_wait):
                print(f"{j['timeline']}: {j.get('status')} {j.get('percent')}%")
        return 0
    except R.ResolveError as e:
        print(f"Resolve: {e}")
        return 3


# ======================================================================= CLI

def _add_render_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--preset", choices=sorted(PRESETS), default="tiktok")
    p.add_argument("--aspect", choices=sorted(ASPECTS), help="перевизначити співвідношення сторін пресету")
    p.add_argument("--fit", choices=["auto", "blur", "crop", "pad", "scale"], default="auto",
                   help="як вписати кадр: розмитий фон / обрізка / поля")
    p.add_argument("--crop-x", dest="crop_x", type=float, default=0.5, help="центр обрізки по горизонталі 0..1")
    p.add_argument("--trim", help="фрагмент 'ПОЧАТОК-КІНЕЦЬ', напр. 0:12-0:45")
    p.add_argument("--lut", help=".cube LUT для кольору")
    p.add_argument("--subs", default="none", help="none | auto (транскрипт/Whisper) | шлях .json/.srt/.ass")
    p.add_argument("--style", choices=["tiktok", "clean"], default="tiktok")
    p.add_argument("--uppercase", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument("--lang", help="мова для Whisper, напр. uk (за замовч. автовизначення)")
    p.add_argument("--title", help="текст-заголовок на початку")
    p.add_argument("--title-dur", dest="title_dur", type=float, default=3.0)
    p.add_argument("--logo", help="PNG логотип")
    p.add_argument("--logo-pos", dest="logo_pos", choices=["tr", "tl", "br", "bl"], default="tr")
    p.add_argument("--logo-scale", dest="logo_scale", type=float, default=0.15)
    p.add_argument("--logo-opacity", dest="logo_opacity", type=float, default=0.9)
    p.add_argument("--no-loudnorm", dest="no_loudnorm", action="store_true", help="без нормалізації гучності")
    p.add_argument("--hw", default="auto", help="auto | cpu | nvenc | qsv | amf | videotoolbox")
    p.add_argument("--crf", type=int, help="якість (менше = краще)")
    p.add_argument("--fps", help="примусова частота кадрів")
    p.add_argument("--out-dir", dest="out_dir")
    p.add_argument("--overwrite", action="store_true")
    p.add_argument("--dry-run", dest="dry_run", action="store_true", help="лише показати команду ffmpeg")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="mtk", description="Медіа-набір: локальна обробка відео з компактним виводом.")
    sp = ap.add_subparsers(dest="cmd", required=True)

    p = sp.add_parser("probe", help="таблиця властивостей файлів/папок")
    p.add_argument("paths", nargs="+")
    p.add_argument("--images", action="store_true")
    p.add_argument("--all", action="store_true")
    p.add_argument("--limit", type=int, default=40)
    p.add_argument("--csv")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_probe)

    p = sp.add_parser("sheet", help="контактний аркуш: одне зображення замість багатьох кадрів")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("--cols", type=int, default=4)
    p.add_argument("--rows", type=int, default=4)
    p.add_argument("--max-side", dest="max_side", type=int, default=1280)
    p.add_argument("--mode", choices=["uniform", "scenes"], default="uniform")
    p.set_defaults(fn=cmd_sheet)

    p = sp.add_parser("scenes", help="моменти зміни сцен")
    p.add_argument("input")
    p.add_argument("--threshold", type=float, default=0.3)
    p.add_argument("--limit", type=int, default=60)
    p.add_argument("--json")
    p.set_defaults(fn=cmd_scenes)

    p = sp.add_parser("silence", help="паузи/тиша (для нарізки мовлення)")
    p.add_argument("input")
    p.add_argument("--noise", type=float, default=-30.0, help="поріг тиші, дБ")
    p.add_argument("--min", type=float, default=0.5, help="мін. тривалість тиші, с")
    p.add_argument("--limit", type=int, default=40)
    p.add_argument("--json")
    p.set_defaults(fn=cmd_silence)

    p = sp.add_parser("loudness", help="гучність EBU R128 і найгучніші моменти")
    p.add_argument("input")
    p.add_argument("--top", type=int, default=8)
    p.set_defaults(fn=cmd_loudness)

    p = sp.add_parser("transcribe", help="Whisper: .txt (компактно) + .srt + .json зі словами")
    p.add_argument("paths", nargs="+")
    p.add_argument("--lang")
    p.add_argument("--model", default="auto", help="auto | large-v3-turbo | large-v3 | medium | small ...")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--out-dir", dest="out_dir")
    p.add_argument("--no-words", dest="no_words", action="store_true")
    p.add_argument("--force", action="store_true")
    p.add_argument("--print", action="store_true", help="вивести компактний текст (для одного файлу)")
    p.set_defaults(fn=cmd_transcribe)

    p = sp.add_parser("highlights", help="кандидати цікавих моментів (евристика + транскрипт)")
    p.add_argument("input")
    p.add_argument("--transcript")
    p.add_argument("--keywords", help="через кому")
    p.add_argument("--target", type=float, default=15.0, help="бажана довжина фрагмента, с")
    p.add_argument("--min", type=float, default=5.0)
    p.add_argument("--max", type=float, default=30.0)
    p.add_argument("--top", type=int, default=8)
    p.add_argument("-o", "--output")
    p.set_defaults(fn=cmd_highlights)

    p = sp.add_parser("cut", help="вирізати і склеїти сегменти (з переходами xfade)")
    p.add_argument("input")
    p.add_argument("--segments")
    p.add_argument("--segments-file", dest="segments_file")
    p.add_argument("--transition", help="fade | dissolve | wipeleft | slideup | circleopen | ... (ffmpeg xfade)")
    p.add_argument("--tdur", type=float, default=0.4)
    p.add_argument("--hw", default="auto")
    p.add_argument("-o", "--output")
    p.set_defaults(fn=cmd_cut)

    p = sp.add_parser("render", help="готове відео під платформу (рамка, субтитри, лого, гучність)")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    _add_render_args(p)
    p.set_defaults(fn=cmd_render)

    p = sp.add_parser("batch", help="render для всієї папки (паралельно, з продовженням)")
    p.add_argument("input_dir")
    p.add_argument("--jobs", type=int, default=2)
    p.add_argument("--pattern", help="фільтр імен, напр. '*.mp4'")
    p.add_argument("--no-recursive", dest="no_recursive", action="store_true")
    _add_render_args(p)
    p.set_defaults(fn=cmd_batch, output=None)

    p = sp.add_parser("timeline", help="OTIO/EDL таймлайн для імпорту в DaVinci Resolve")
    p.add_argument("source")
    p.add_argument("--segments")
    p.add_argument("--segments-file", dest="segments_file")
    p.add_argument("--fps", type=float)
    p.add_argument("--dissolve", type=float, default=0.0, help="перехід між кліпами, с")
    p.add_argument("--name")
    p.add_argument("--edl", action="store_true", help="також зберегти .edl")
    p.add_argument("-o", "--output")
    p.set_defaults(fn=cmd_timeline)

    p = sp.add_parser("frames", help="кадри в заданих моментах (для перевірки)")
    p.add_argument("input")
    p.add_argument("--at", required=True, help="часи через кому: 0:05,1:02.5")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--out-dir", dest="out_dir")
    p.set_defaults(fn=cmd_frames)

    p = sp.add_parser("doctor", help="перевірка FFmpeg, кодерів, Whisper, Resolve")
    p.set_defaults(fn=cmd_doctor)

    p = sp.add_parser("resolve", help="масові операції через API DaVinci Resolve Studio")
    rs = p.add_subparsers(dest="rcmd", required=True)
    rs.add_parser("info")
    rs.add_parser("presets")
    q = rs.add_parser("import-media")
    q.add_argument("paths", nargs="+")
    q.add_argument("--bin")
    q = rs.add_parser("import-timeline")
    q.add_argument("file")
    q.add_argument("--name")
    q = rs.add_parser("markers")
    q.add_argument("file", help="highlights.json")
    q.add_argument("--color", default="Blue")
    q = rs.add_parser("render")
    q.add_argument("--preset")
    q.add_argument("--timelines", default="current", help="current | all | частина назви")
    q.add_argument("--target-dir", dest="target_dir")
    q.add_argument("--no-wait", dest="no_wait", action="store_true")
    p.set_defaults(fn=cmd_resolve)
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles
        except (AttributeError, ValueError):
            pass
    a = build_parser().parse_args(argv)
    try:
        return int(a.fn(a) or 0)
    except M.MediaError as e:
        print(f"FFmpeg: {e}")
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
