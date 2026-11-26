"""Bulk operations through the official DaVinci Resolve (Studio) scripting API.

Why this exists next to Resolve's built-in MCP (Studio 21.1+): one script call can process hundreds of
items, while MCP needs one tool call per item (tokens). Requires Resolve Studio running with
Preferences > System > General > External scripting using = Local.

STATUS: written against the documented API (Developer/Scripting/README.txt); not yet run against a real
Resolve install — verify with `mtk resolve info` on the target PC.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import sys
import time
from pathlib import Path

from .common import IS_MAC, IS_WINDOWS


class ResolveError(RuntimeError):
    pass


def default_paths() -> tuple[str, str]:
    if IS_WINDOWS:
        pd = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
        pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        return (rf"{pd}\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting",
                rf"{pf}\Blackmagic Design\DaVinci Resolve\fusionscript.dll")
    if IS_MAC:
        return ("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
                "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so")
    return ("/opt/resolve/Developer/Scripting", "/opt/resolve/libs/Fusion/fusionscript.so")


def script_paths() -> tuple[str, str]:
    api, lib = default_paths()
    return os.environ.get("RESOLVE_SCRIPT_API", api), os.environ.get("RESOLVE_SCRIPT_LIB", lib)


def connect():
    api, lib = script_paths()
    if not Path(lib).exists():
        raise ResolveError(f"Не знайдено fusionscript ({lib}). DaVinci Resolve Studio встановлено? "
                           "Шлях можна задати змінною RESOLVE_SCRIPT_LIB.")
    modules = str(Path(api) / "Modules")
    if modules not in sys.path:
        sys.path.append(modules)
    loader = importlib.machinery.ExtensionFileLoader("fusionscript", lib)
    spec = importlib.util.spec_from_loader("fusionscript", loader)
    if spec is None:
        raise ResolveError("Не вдалося завантажити fusionscript")
    module = importlib.util.module_from_spec(spec)
    try:
        loader.exec_module(module)
    except Exception as e:  # ABI mismatch / missing deps
        raise ResolveError(f"fusionscript не завантажився цією версією Python ({sys.version.split()[0]}): {e}") from e
    resolve = module.scriptapp("Resolve")
    if resolve is None:
        raise ResolveError("Resolve не відповідає. Запустіть DaVinci Resolve Studio і ввімкніть "
                           "Preferences > System > General > External scripting using: Local.")
    return resolve


def _project(resolve):
    pm = resolve.GetProjectManager()
    proj = pm.GetCurrentProject() if pm else None
    if not proj:
        raise ResolveError("Немає відкритого проєкту в Resolve.")
    return proj


def info() -> dict:
    r = connect()
    proj = _project(r)
    mp = proj.GetMediaPool()
    root = mp.GetRootFolder() if mp else None
    tl = proj.GetCurrentTimeline()
    return {
        "product": r.GetProductName(), "version": r.GetVersionString(), "page": r.GetCurrentPage(),
        "project": proj.GetName(), "timelines": proj.GetTimelineCount(),
        "current_timeline": tl.GetName() if tl else None,
        "root_clips": len(root.GetClipList() or []) if root else None,
        "render_presets": len(proj.GetRenderPresetList() or []),
    }


def import_media(paths: list[str], bin_name: str | None = None) -> int:
    r = connect()
    proj = _project(r)
    mp = proj.GetMediaPool()
    if bin_name:
        root = mp.GetRootFolder()
        target = next((f for f in (root.GetSubFolderList() or []) if f.GetName() == bin_name), None)
        target = target or mp.AddSubFolder(root, bin_name)
        mp.SetCurrentFolder(target)
    items = mp.ImportMedia([str(Path(p).resolve()) for p in paths]) or []
    return len(items)


def import_timeline(path: str, name: str | None = None) -> str:
    r = connect()
    proj = _project(r)
    mp = proj.GetMediaPool()
    opts = {"timelineName": name} if name else {}
    tl = mp.ImportTimelineFromFile(str(Path(path).resolve()), opts)
    if not tl:
        raise ResolveError("Resolve не імпортував таймлайн (перевірте, що кліпи доступні за шляхами з файлу).")
    return tl.GetName()


def add_markers(segments: list[dict], color: str = "Blue") -> int:
    r = connect()
    proj = _project(r)
    tl = proj.GetCurrentTimeline()
    if not tl:
        raise ResolveError("Немає активного таймлайну.")
    fps = float(tl.GetSetting("timelineFrameRate") or 25)
    added = 0
    for i, s in enumerate(segments, 1):
        frame = int(round(float(s["start"]) * fps))
        dur = max(1, int(round((float(s["end"]) - float(s["start"])) * fps)))
        note = str(s.get("text") or s.get("reasons") or "")[:250]
        if tl.AddMarker(frame, color, f"H{i}", note, dur):
            added += 1
    return added


def render(preset: str | None, timelines: str = "current", target_dir: str | None = None,
           wait: bool = True, poll: float = 5.0) -> list[dict]:
    r = connect()
    proj = _project(r)
    count = proj.GetTimelineCount()
    all_tl = [proj.GetTimelineByIndex(i) for i in range(1, count + 1)]
    if timelines == "current":
        chosen = [proj.GetCurrentTimeline()]
    elif timelines == "all":
        chosen = all_tl
    else:
        chosen = [t for t in all_tl if t and timelines.lower() in t.GetName().lower()]
    chosen = [t for t in chosen if t]
    if not chosen:
        raise ResolveError("Не знайдено таймлайнів для рендеру.")
    jobs = []
    for tl in chosen:
        proj.SetCurrentTimeline(tl)
        if preset and not proj.LoadRenderPreset(preset):
            raise ResolveError(f"Пресет рендеру не знайдено: {preset}")
        settings = {"SelectAllFrames": True, "CustomName": tl.GetName()}
        if target_dir:
            Path(target_dir).mkdir(parents=True, exist_ok=True)
            settings["TargetDir"] = str(Path(target_dir).resolve())
        proj.SetRenderSettings(settings)
        job = proj.AddRenderJob()
        if job:
            jobs.append({"job": job, "timeline": tl.GetName()})
    if not jobs:
        raise ResolveError("Не вдалося додати завдання рендеру.")
    proj.StartRendering([j["job"] for j in jobs])
    if wait:
        while proj.IsRenderingInProgress():
            time.sleep(poll)
    for j in jobs:
        st = proj.GetRenderJobStatus(j["job"]) or {}
        j["status"] = st.get("JobStatus")
        j["percent"] = st.get("CompletionPercentage")
    return jobs


def presets() -> list[str]:
    proj = _project(connect())
    return list(proj.GetRenderPresetList() or [])
