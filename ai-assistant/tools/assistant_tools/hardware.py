"""Hardware detection and local-model planning. Stdlib only; collects no names/serials/usernames."""

from __future__ import annotations

import os
import platform
import re
import shutil
import time
from pathlib import Path

from .common import IS_MAC, IS_WINDOWS, run, which

INTEGRATED = re.compile(r"\b(uhd|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|"
                        r"intel\(r\) graphics|arc\(tm\) graphics$|microsoft basic|remote display|virtual|parsec|"
                        r"llvmpipe|svga)\b", re.I)


def ram_gb() -> float:
    try:
        if IS_WINDOWS:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))  # type: ignore[attr-defined]
            return st.ullTotalPhys / 2**30
        if IS_MAC:
            _, out, _ = run(["sysctl", "-n", "hw.memsize"], timeout=10)
            return int(out.strip()) / 2**30
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) / 2**20
    except Exception:
        pass
    return 0.0


def cpu_name() -> str:
    try:
        if IS_WINDOWS:
            import winreg  # type: ignore
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        if IS_MAC:
            _, out, _ = run(["sysctl", "-n", "machdep.cpu.brand_string"], timeout=10)
            return out.strip()
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return platform.processor() or "?"


def _vendor(name: str) -> str:
    n = name.lower()
    if "nvidia" in n or "geforce" in n or "rtx" in n or "quadro" in n:
        return "nvidia"
    if "amd" in n or "radeon" in n:
        return "amd"
    if "intel" in n or "arc" in n:
        return "intel"
    if "apple" in n:
        return "apple"
    return "other"


def gpus() -> list[dict]:
    found: list[dict] = []
    if which("nvidia-smi"):
        code, out, _ = run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], timeout=20)
        if code == 0:
            for line in out.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2:
                    try:
                        found.append({"name": parts[0], "vendor": "nvidia", "vram_gb": round(float(parts[1]) / 1024, 1),
                                      "integrated": False, "source": "nvidia-smi"})
                    except ValueError:
                        pass
    if IS_WINDOWS:
        found += _windows_registry_gpus(skip_nvidia=any(g["vendor"] == "nvidia" for g in found))
    elif IS_MAC:
        if platform.machine() == "arm64":
            ram = ram_gb()
            found.append({"name": cpu_name(), "vendor": "apple", "vram_gb": round(ram * 0.65, 1), "integrated": False,
                          "unified": True, "source": "apple-silicon"})
    else:
        found += _linux_drm_gpus(skip_nvidia=any(g["vendor"] == "nvidia" for g in found))
    for g in found:
        g.setdefault("integrated", bool(INTEGRATED.search(g["name"])) or g.get("vram_gb", 0) < 2)
    return found


def _windows_registry_gpus(skip_nvidia: bool) -> list[dict]:
    out: list[dict] = []
    try:
        import winreg  # type: ignore
        base = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as root:
            for i in range(0, 32):
                try:
                    sub = winreg.EnumKey(root, i)
                except OSError:
                    break
                if not sub.isdigit():
                    continue
                try:
                    with winreg.OpenKey(root, sub) as k:
                        name = str(winreg.QueryValueEx(k, "DriverDesc")[0])
                        mem = 0
                        for val in ("HardwareInformation.qwMemorySize", "HardwareInformation.MemorySize"):
                            try:
                                raw = winreg.QueryValueEx(k, val)[0]
                                mem = int.from_bytes(raw, "little") if isinstance(raw, (bytes, bytearray)) else int(raw)
                                if mem:
                                    break
                            except OSError:
                                continue
                except OSError:
                    continue
                vendor = _vendor(name)
                if skip_nvidia and vendor == "nvidia":
                    continue
                if any(o["name"] == name for o in out):
                    continue
                out.append({"name": name, "vendor": vendor, "vram_gb": round(mem / 2**30, 1),
                            "integrated": bool(INTEGRATED.search(name)) or mem < 2 * 2**30, "source": "registry"})
    except Exception:
        pass
    return out


def _linux_drm_gpus(skip_nvidia: bool) -> list[dict]:
    out: list[dict] = []
    vendors = {"0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel"}
    for card in sorted(Path("/sys/class/drm").glob("card[0-9]")):
        try:
            vendor = vendors.get((card / "device" / "vendor").read_text().strip(), "other")
        except OSError:
            continue
        if skip_nvidia and vendor == "nvidia":
            continue
        vram = 0.0
        try:
            vram = int((card / "device" / "mem_info_vram_total").read_text().strip()) / 2**30
        except (OSError, ValueError):
            pass
        out.append({"name": f"{vendor} gpu", "vendor": vendor, "vram_gb": round(vram, 1),
                    "integrated": vendor == "intel" or vram < 2, "source": "drm"})
    return out


def detect() -> dict:
    du = shutil.disk_usage(Path.home())
    return {
        "os": platform.system(), "os_release": platform.release(), "os_version": platform.version(),
        "arch": platform.machine(), "cpu": cpu_name(), "cpu_threads": os.cpu_count() or 1,
        "ram_gb": round(ram_gb(), 1), "gpus": gpus(), "disk_free_gb": round(du.free / 2**30, 1),
        "python": platform.python_version(), "detected_at": time.strftime("%Y-%m-%d %H:%M"),
    }


def best_gpu(hw: dict) -> dict | None:
    cands = [g for g in hw.get("gpus", []) if not g.get("integrated")]
    return max(cands, key=lambda g: g.get("vram_gb", 0)) if cands else None


def make_plan(hw: dict, catalog: dict) -> dict:
    g = best_gpu(hw)
    vendor = g["vendor"] if g else None
    vram = float(g.get("vram_gb", 0)) if g else 0.0
    accel = vendor in ("nvidia", "amd", "apple")
    eff_vram = vram if accel else 0.0
    ram = float(hw.get("ram_gb", 0))
    threads = int(hw.get("cpu_threads", 1))
    free = float(hw.get("disk_free_gb", 0))

    chosen = catalog["tiers"][0]
    for t in catalog["tiers"]:
        ok_gpu = t.get("min_vram") is not None and eff_vram >= t["min_vram"] and ram >= t.get("min_ram", 0)
        ok_cpu = eff_vram == 0 and t.get("min_ram_cpu") is not None and ram >= t["min_ram_cpu"]
        if ok_gpu or ok_cpu:
            chosen = t
    notes: list[str] = []
    required = [m for m in chosen.get("models", []) if not m.get("optional")]
    need_gb = sum(m.get("size_gb", 0) for m in required)
    if need_gb and free - need_gb < 20:
        notes.append(f"Мало місця на диску ({free:.0f} ГБ вільно): локальні моделі не завантажуємо автоматично.")
        chosen = catalog["tiers"][0]
        required = []
    llm = {"tier": chosen["id"], "label": chosen.get("label", chosen["id"]),
           "pull": [m["tag"] for m in required],
           "optional": [m["tag"] for m in chosen.get("models", []) if m.get("optional")],
           "alternatives": {m["tag"]: m.get("alternatives", []) for m in chosen.get("models", [])}}
    for role in ("text", "vision"):
        for m in required:
            if role in m.get("roles", []):
                llm[role] = m["tag"]
                break

    if vendor == "nvidia" and vram >= 6:
        whisper = {"model": "large-v3-turbo", "device": "cuda", "install_cuda_libs": True}
    elif vendor == "nvidia" and vram >= 3:
        whisper = {"model": "medium", "device": "cuda", "install_cuda_libs": True}
    elif threads >= 8 and ram >= 16:
        whisper = {"model": "large-v3-turbo", "device": "cpu", "install_cuda_libs": False}
    elif ram >= 8:
        whisper = {"model": "medium", "device": "cpu", "install_cuda_libs": False}
    else:
        whisper = {"model": "small", "device": "cpu", "install_cuda_libs": False}
    if whisper["device"] == "cpu":
        notes.append("Транскрипція на процесорі: повільніше, ніж на NVIDIA, але працює (зручно запускати пакетом).")

    encoder = {"nvidia": "nvenc", "amd": "amf", "intel": "qsv", "apple": "videotoolbox"}.get(vendor or "", "cpu")
    if not g:
        igpu = next((x for x in hw.get("gpus", []) if x.get("vendor") == "intel"), None)
        encoder = "qsv" if igpu else "cpu"
    if chosen["id"] == "none":
        notes.append("Локальні моделі не рекомендовані для цього ПК — Claude працює повністю без них.")
    return {"created_at": time.strftime("%Y-%m-%d %H:%M"), "catalog_verified": catalog.get("verified"),
            "gpu": g, "ram_gb": ram, "llm": llm, "whisper": whisper, "video_encoder_hint": encoder, "notes": notes}


def summary(hw: dict) -> str:
    g = best_gpu(hw)
    gpu = f"{g['name']} ({g['vram_gb']} ГБ)" if g else "немає дискретної відеокарти"
    return (f"{hw['os']} {hw['os_release']} | CPU: {hw['cpu']} ({hw['cpu_threads']} потоків) | "
            f"RAM: {hw['ram_gb']} ГБ | GPU: {gpu} | вільно на диску: {hw['disk_free_gb']} ГБ")
