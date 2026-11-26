"""assistant-setup — detect hardware, plan local models, deploy the global Claude config, backup/restore, doctor.

All writes to ~/.claude are preceded by a timestamped backup in ~/.claude-assistant/backups/.
Files we manage carry the marker "managed-by: universal-assistant"; user files are never deleted.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from . import __version__
from .common import IS_WINDOWS, assistant_home, claude_home, load_json, run, save_json, which
from .hardware import detect, make_plan, summary
from .redact import find_secrets, redact_json, redact_text

MARK = "managed-by: universal-assistant"
BACKUP_ITEMS = ["CLAUDE.md", "settings.json", "keybindings.json", "agents", "skills", "commands", "rules",
                "output-styles", "themes", "workflows"]
NEVER_COPY = {".credentials.json", ".env"}
TEXT_SUFFIXES = {".md", ".json", ".txt", ".yaml", ".yml", ".toml", ".py", ".js", ".mjs", ".ts", ".sh", ".ps1", ".cmd", ""}


def source_dir(arg: str | None = None) -> Path:
    cand = Path(arg or os.environ.get("ASSISTANT_SOURCE") or Path(__file__).resolve().parents[2])
    if not (cand / "claude" / "settings.template.json").exists():
        raise SystemExit(f"Не знайдено пакет конфігурації в {cand} (потрібна папка ai-assistant). Вкажіть --source.")
    return cand


def _short_path(p: Path) -> str:
    """Command string usable from Git Bash and PowerShell: forward slashes, no spaces if possible."""
    s = str(p)
    if IS_WINDOWS and " " in s:
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(1024)
            if ctypes.windll.kernel32.GetShortPathNameW(s, buf, 1024):  # type: ignore[attr-defined]
                s = buf.value
        except Exception:
            pass
    s = s.replace("\\", "/")
    return f'"{s}"' if " " in s else s


def tool_command(name: str, module: str) -> str:
    exe = Path(sys.executable).parent / (f"{name}.exe" if IS_WINDOWS else name)
    if exe.exists():
        return _short_path(exe)
    found = which(name)
    if found:
        return _short_path(Path(found))
    return f"{_short_path(Path(sys.executable))} -m assistant_tools.{module}"


# ---------------------------------------------------------------- settings merge

def _is_ours(entry: object) -> bool:
    s = json.dumps(entry, ensure_ascii=False)
    return "assistant-guard" in s or "assistant_tools.guard" in s


def _fill(obj, values: dict[str, str]):
    if isinstance(obj, dict):
        return {k: _fill(v, values) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_fill(v, values) for v in obj]
    if isinstance(obj, str):
        for k, v in values.items():
            obj = obj.replace("{{" + k + "}}", v)
    return obj


def render_template(src: Path) -> dict:
    tmpl = json.loads((src / "claude" / "settings.template.json").read_text(encoding="utf-8"))
    tmpl.pop("_comment", None)
    return _fill(tmpl, {"GUARD_COMMAND": tool_command("assistant-guard", "guard"),
                        "STATUSLINE_COMMAND": tool_command("assistant-statusline", "statusline")})


def merge_settings(cur: dict, tmpl: dict) -> tuple[dict, list[str]]:
    out = copy.deepcopy(cur)
    notes: list[str] = []
    perms = out.setdefault("permissions", {})
    for k in ("allow", "ask", "deny"):
        lst = perms.setdefault(k, [])
        for rule in tmpl.get("permissions", {}).get(k, []):
            if rule not in lst:
                lst.append(rule)
    for event, entries in tmpl.get("hooks", {}).items():
        cur_entries = out.setdefault("hooks", {}).setdefault(event, [])
        cur_entries[:] = [e for e in cur_entries if not _is_ours(e)]
        cur_entries.extend(entries)
    if "statusLine" in tmpl:
        sl = out.get("statusLine")
        if not sl or "assistant-statusline" in json.dumps(sl) or "assistant_tools.statusline" in json.dumps(sl):
            out["statusLine"] = tmpl["statusLine"]
        else:
            notes.append("рядок стану: залишено ваш власний (наш не встановлено)")
    for k, v in tmpl.get("env", {}).items():
        if k in out.setdefault("env", {}) and out["env"][k] != v:
            notes.append(f"env.{k}: залишено ваше значення")
        out["env"].setdefault(k, v)
    for k, v in tmpl.items():
        if k not in ("permissions", "hooks", "statusLine", "env") and k not in out:
            out[k] = v
    return out, notes


def unmerge_settings(cur: dict, tmpl: dict) -> dict:
    out = copy.deepcopy(cur)
    for k in ("allow", "ask", "deny"):
        theirs = tmpl.get("permissions", {}).get(k, [])
        if k in out.get("permissions", {}):
            out["permissions"][k] = [r for r in out["permissions"][k] if r not in theirs]
    for event in list(out.get("hooks", {})):
        out["hooks"][event] = [e for e in out["hooks"][event] if not _is_ours(e)]
        if not out["hooks"][event]:
            del out["hooks"][event]
    if "statusLine" in out and ("assistant-statusline" in json.dumps(out["statusLine"])
                                or "assistant_tools.statusline" in json.dumps(out["statusLine"])):
        del out["statusLine"]
    for k, v in tmpl.get("env", {}).items():
        if out.get("env", {}).get(k) == v:
            del out["env"][k]
    return out


# ---------------------------------------------------------------- deploy

class Deployer:
    def __init__(self, src: Path, dry: bool):
        self.src, self.dry = src, dry
        self.ch = claude_home()
        self.backup_dir = assistant_home() / "backups" / time.strftime("%Y%m%d-%H%M%S")
        self.log: list[str] = []

    def _backup(self, target: Path) -> None:
        if not target.exists():
            return
        rel = target.relative_to(self.ch) if self.ch in target.parents else Path(target.name)
        dest = self.backup_dir / rel
        if self.dry:
            return
        dest.parent.mkdir(parents=True, exist_ok=True)
        if target.is_dir():
            shutil.copytree(target, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(target, dest)

    def copy_file(self, s: Path, d: Path) -> None:
        new = s.read_bytes()
        if d.exists():
            old = d.read_bytes()
            if old == new:
                return
            self._backup(d)
            mine = MARK.encode() in old
            self.log.append(f"{'оновлено' if mine else 'замінено (ваша копія збережена)'}: {d}")
        else:
            self.log.append(f"додано: {d}")
        if not self.dry:
            d.parent.mkdir(parents=True, exist_ok=True)
            d.write_bytes(new)

    def copy_tree(self, s: Path, d: Path) -> None:
        for f in sorted(s.rglob("*")):
            if f.is_file():
                self.copy_file(f, d / f.relative_to(s))

    def run(self) -> list[str]:
        c = self.src / "claude"
        for sub in ("rules", "agents"):
            for f in sorted((c / sub).glob("*.md")):
                self.copy_file(f, self.ch / sub / f.name)
        for d in sorted(p for p in (c / "skills").iterdir() if p.is_dir()):
            self.copy_tree(d, self.ch / "skills" / d.name)
        sp = self.ch / "settings.json"
        try:
            cur = load_json(sp, {}) or {}
        except json.JSONDecodeError as e:
            raise SystemExit(f"{sp} містить помилку JSON — виправте або перейменуйте файл і повторіть.") from e
        merged, notes = merge_settings(cur, render_template(self.src))
        if merged != cur:
            self._backup(sp)
            self.log.append(f"оновлено налаштування: {sp}")
            if not self.dry:
                save_json(sp, merged)
        self.log += [f"примітка: {n}" for n in notes]
        if not self.dry:
            save_json(assistant_home() / "state.json", {"version": __version__, "source": str(self.src),
                                                        "deployed_at": time.strftime("%Y-%m-%d %H:%M"),
                                                        "backup": str(self.backup_dir)})
        return self.log


def cmd_deploy(a: argparse.Namespace) -> int:
    src = source_dir(a.source)
    d = Deployer(src, a.dry_run)
    log = d.run()
    print(("[перевірка, нічого не змінено] " if a.dry_run else "") + f"Конфігурація → {d.ch}")
    for line in log or ["змін немає — усе вже актуальне"]:
        print("  " + line)
    if log and not a.dry_run:
        print(f"Резервна копія попередніх файлів: {d.backup_dir}")
    return 0


def cmd_undeploy(a: argparse.Namespace) -> int:
    src = source_dir(a.source)
    ch = claude_home()
    removed = []
    for sub in ("rules", "agents"):
        for f in (src / "claude" / sub).glob("*.md"):
            t = ch / sub / f.name
            if t.exists() and MARK in t.read_text(encoding="utf-8", errors="replace"):
                removed.append(t)
    for d in (src / "claude" / "skills").iterdir():
        t = ch / "skills" / d.name / "SKILL.md"
        if t.exists() and MARK in t.read_text(encoding="utf-8", errors="replace"):
            removed.append(t.parent)
    sp = ch / "settings.json"
    cur = load_json(sp, {}) or {}
    new = unmerge_settings(cur, render_template(src))
    print("Буде прибрано: " + ", ".join(str(r) for r in removed) + ("; записи в settings.json" if new != cur else ""))
    if a.dry_run:
        return 0
    bdir = assistant_home() / "backups" / ("undeploy-" + time.strftime("%Y%m%d-%H%M%S"))
    for r in removed:
        dest = bdir / r.relative_to(ch)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(r), str(dest))  # moved to backup, not deleted
    if new != cur:
        dest = bdir / "settings.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(sp, dest)
        save_json(sp, new)
    print(f"Готово. Усе прибране збережено в {bdir}")
    return 0


# ---------------------------------------------------------------- detect / plan / models

def _catalog(src: Path) -> dict:
    return json.loads((src / "config" / "models.json").read_text(encoding="utf-8"))


def cmd_detect(a: argparse.Namespace) -> int:
    hw = detect()
    save_json(assistant_home() / "hardware.json", hw)
    print(summary(hw))
    return 0


def cmd_plan(a: argparse.Namespace) -> int:
    hw = load_json(assistant_home() / "hardware.json") or detect()
    plan = make_plan(hw, _catalog(source_dir(a.source)))
    save_json(assistant_home() / "plan.json", plan)
    if a.json:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0
    llm = plan["llm"]
    print(summary(hw))
    print(f"Локальні моделі: рівень «{llm['label']}»" + (f" → {', '.join(llm['pull'])}" if llm["pull"] else ""))
    if llm.get("optional"):
        print(f"  за бажанням: {', '.join(llm['optional'])}")
    w = plan["whisper"]
    print(f"Whisper: {w['model']} на {'відеокарті' if w['device'] == 'cuda' else 'процесорі'} | "
          f"кодування відео: {plan['video_encoder_hint']}")
    for n in plan["notes"]:
        print("  • " + n)
    return 0


def _ollama_tags() -> list[str]:
    code, out, _ = run(["ollama", "list"], timeout=30)
    if code != 0:
        return []
    return [line.split()[0] for line in out.splitlines()[1:] if line.strip()]


def _disable_ollama_cloud() -> str:
    p = Path.home() / ".ollama" / "server.json"
    data = load_json(p, {}) or {}
    if data.get("disable_ollama_cloud") is True:
        return "хмарні функції Ollama вже вимкнено"
    data["disable_ollama_cloud"] = True
    save_json(p, data)
    return f"хмарні функції Ollama вимкнено ({p}); перезапустіть Ollama"


def cmd_models(a: argparse.Namespace) -> int:
    plan = load_json(assistant_home() / "plan.json")
    if not plan:
        print("Спершу: assistant-setup detect && assistant-setup plan")
        return 2
    if not which("ollama"):
        print("Ollama не встановлено — локальні моделі пропущено (Claude працює без них).")
        return 0
    print(_disable_ollama_cloud())
    have = _ollama_tags()
    wanted = plan["llm"]["pull"] + (plan["llm"].get("optional", []) if a.optional else [])
    if not wanted:
        print("Для цього ПК локальні моделі не плануються.")
        return 0
    for tag in wanted:
        if any(h == tag or h == tag + ":latest" for h in have):
            print(f"✓ {tag} вже є")
            continue
        if not a.pull:
            print(f"• {tag} — не завантажено (додайте --pull)")
            continue
        for cand in [tag] + plan["llm"].get("alternatives", {}).get(tag, []):
            print(f"Завантаження {cand} …")
            if subprocess.call(["ollama", "pull", cand]) == 0:
                for role in ("text", "vision"):
                    if plan["llm"].get(role) == tag:
                        plan["llm"][role] = cand
                break
            print(f"  не вдалося: {cand}, пробую альтернативу")
    save_json(assistant_home() / "plan.json", plan)
    return 0


# ---------------------------------------------------------------- backup / restore

def _copy_sanitized(src: Path, dst: Path, stats: dict[str, int]) -> None:
    if src.name in NEVER_COPY or src.suffix.lower() in (".pem", ".key", ".pfx", ".p12"):
        stats["skipped"] = stats.get("skipped", 0) + 1
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() == ".json":
        try:
            data, c = redact_json(json.loads(src.read_text(encoding="utf-8")))
            dst.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            for k, v in c.items():
                stats[k] = stats.get(k, 0) + v
            return
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    if src.suffix.lower() in TEXT_SUFFIXES:
        try:
            text, c = redact_text(src.read_text(encoding="utf-8"))
            dst.write_text(text, encoding="utf-8")
            for k, v in c.items():
                stats[k] = stats.get(k, 0) + v
            return
        except UnicodeDecodeError:
            pass
    shutil.copy2(src, dst)


def cmd_backup(a: argparse.Namespace) -> int:
    ch = claude_home()
    out_dir = Path(a.out).expanduser() if a.out else Path.home() / "Documents" / "Claude-backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"claude-config-{time.strftime('%Y%m%d-%H%M%S')}"
    stats: dict[str, int] = {}
    with tempfile.TemporaryDirectory() as td:
        stage = Path(td) / name
        for item in BACKUP_ITEMS:
            p = ch / item
            if p.is_file():
                _copy_sanitized(p, stage / "claude" / item, stats)
            elif p.is_dir():
                for f in sorted(p.rglob("*")):
                    if f.is_file() and "node_modules" not in f.parts:
                        _copy_sanitized(f, stage / "claude" / item / f.relative_to(p), stats)
        cj = load_json(Path.home() / ".claude.json", {}) or {}
        mcp, c = redact_json({"mcpServers": cj.get("mcpServers", {})})
        for k, v in c.items():
            stats[k] = stats.get(k, 0) + v
        save_json(stage / "mcp-servers.json", mcp)
        plugins = {}
        for fn in ("known_marketplaces.json", "installed_plugins.json"):
            data = load_json(ch / "plugins" / fn)
            if data is not None:
                plugins[fn] = redact_json(data)[0]
        if plugins:
            save_json(stage / "plugins.json", plugins)
        for fn in ("hardware.json", "plan.json"):
            if (assistant_home() / fn).exists():
                shutil.copy2(assistant_home() / fn, stage / fn)
        leftovers = []
        for f in stage.rglob("*"):
            if f.is_file():
                try:
                    hits = find_secrets(f.read_text(encoding="utf-8"))
                except UnicodeDecodeError:
                    continue
                if hits:
                    leftovers.append(f"{f.relative_to(stage)}: {','.join(hits)}")
        if leftovers:
            print("ЗУПИНЕНО: після очищення лишилися схожі на секрети фрагменти:\n  " + "\n  ".join(leftovers))
            return 1
        save_json(stage / "manifest.json", {"format": 1, "tool_version": __version__,
                                            "created_at": time.strftime("%Y-%m-%d %H:%M"),
                                            "redactions": stats, "items": BACKUP_ITEMS})
        zpath = out_dir / f"{name}.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(stage.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(stage))
    red = sum(v for k, v in stats.items() if k != "skipped")
    print(f"Резервна копія без секретів: {zpath}")
    print(f"  приховано значень: {red}; пропущено файлів із ключами: {stats.get('skipped', 0)}. "
          "Паролі/токени/ключі API не зберігаються — після відновлення їх треба ввести заново.")
    return 0


def cmd_restore(a: argparse.Namespace) -> int:
    src = Path(a.backup).expanduser()
    ch = claude_home()
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        if src.is_file():
            with zipfile.ZipFile(src) as z:
                for m in z.namelist():
                    if m.startswith("/") or ".." in Path(m).parts:
                        raise SystemExit(f"Небезпечний шлях в архіві: {m}")
                z.extractall(root)
        else:
            shutil.copytree(src, root, dirs_exist_ok=True)
        if not (root / "manifest.json").exists():
            raise SystemExit("Це не резервна копія assistant-setup (немає manifest.json).")
        dep = Deployer(Path(td), a.dry_run)  # only its backup/copy helpers are used here
        cfg = root / "claude"
        for item in BACKUP_ITEMS:
            p = cfg / item
            if item == "settings.json" or not p.exists():
                continue
            if p.is_file():
                dep.copy_file(p, ch / item)
            else:
                dep.copy_tree(p, ch / item)
        restored = load_json(cfg / "settings.json", {}) or {}
        cur = load_json(ch / "settings.json", {}) or {}
        merged = copy.deepcopy(cur)
        for k, v in restored.items():
            if k == "hooks":
                v = {e: [x for x in lst if not _is_ours(x)] for e, lst in v.items()}  # paths are machine-specific
            if k == "statusLine" and ("assistant-statusline" in json.dumps(v) or "assistant_tools.statusline" in json.dumps(v)):
                continue
            if isinstance(v, dict) and isinstance(merged.get(k), dict):
                merged[k] = {**merged[k], **v}
            else:
                merged[k] = v
        if merged != cur:
            dep._backup(ch / "settings.json")
            dep.log.append(f"відновлено налаштування: {ch / 'settings.json'}")
            if not a.dry_run:
                save_json(ch / "settings.json", merged)
        mcp = (load_json(root / "mcp-servers.json", {}) or {}).get("mcpServers", {})
    for line in dep.log or ["нічого не змінено"]:
        print("  " + line)
    if mcp:
        print("MCP-сервери з резервної копії (додайте заново; значення <REDACTED> введіть самі):")
        for name, cfg_ in mcp.items():
            flag = " ← потрібні ключі" if "<REDACTED" in json.dumps(cfg_) else ""
            print(f"  claude mcp add-json --scope user {name} '{json.dumps(cfg_, ensure_ascii=False)}'{flag}")
    print("Далі запустіть: assistant-setup deploy  (оновить шляхи захисту і рядка стану для цього ПК)")
    return 0


# ---------------------------------------------------------------- doctor

def _ver(cmd: list[str]) -> str | None:
    if not which(cmd[0]):
        return None
    code, out, err = run(cmd, timeout=30)
    text = (out or err).strip().splitlines()
    return text[0][:60] if text else "є"


def cmd_doctor(a: argparse.Namespace) -> int:
    ch = claude_home()
    rows: list[tuple[str, str, str]] = []

    def add(name: str, ok: bool | None, detail: str) -> None:
        rows.append(("✓" if ok else ("–" if ok is None else "✗"), name, detail))

    v = _ver(["claude", "--version"])
    add("Claude Code (CLI)", bool(v), v or "встановіть: irm https://claude.ai/install.ps1 | iex")
    for name, cmd, hint, required in [
        ("Git", ["git", "--version"], "winget install Git.Git", True),
        ("uv (Python)", ["uv", "--version"], "winget install astral-sh.uv", True),
        ("FFmpeg", ["ffmpeg", "-version"], "winget install Gyan.FFmpeg", True),
        ("Node.js", ["node", "--version"], "winget install OpenJS.NodeJS.LTS", False),
        ("GitHub CLI", ["gh", "--version"], "winget install GitHub.cli", False),
        ("auto-editor", ["auto-editor", "--version"], "uv tool install auto-editor", False),
        ("Playwright CLI", ["playwright-cli", "--version"], "npm install -g @playwright/cli@latest", False),
        ("Ollama", ["ollama", "--version"], "winget install Ollama.Ollama (необов'язково)", False),
    ]:
        v = _ver(cmd)
        add(name, True if v else (False if required else None), v or hint)
    nv = _ver(["node", "--version"])
    if nv:
        try:
            major, minor = (int(x) for x in nv.lstrip("v").split(".")[:2])
            if (major, minor) < (22, 13):
                add("Node.js ≥ 22.13 (для ctx7)", False, f"зараз {nv}: winget upgrade OpenJS.NodeJS.LTS")
        except ValueError:
            pass
    try:
        import faster_whisper  # type: ignore  # noqa: F401
        add("Whisper (faster-whisper)", True, "транскрипція доступна")
    except ImportError:
        add("Whisper (faster-whisper)", False, "uv tool install --editable <ai-assistant>/tools --with faster-whisper")
    from .resolve_bridge import script_paths
    _, lib = script_paths()
    add("DaVinci Resolve API", Path(lib).exists() or None, "знайдено" if Path(lib).exists() else "не знайдено (потрібен Resolve Studio)")
    add("Правила Claude", (ch / "rules" / "universal-assistant.md").exists(), str(ch / "rules"))
    agents = [p.name for p in (ch / "agents").glob("*.md") if MARK in p.read_text(encoding="utf-8", errors="replace")] if (ch / "agents").exists() else []
    add("Агенти", bool(agents), ", ".join(sorted(a_.removesuffix(".md") for a_ in agents)) or "assistant-setup deploy")
    skills = [p.parent.name for p in (ch / "skills").glob("*/SKILL.md")] if (ch / "skills").exists() else []
    add("Skills", bool(skills), ", ".join(sorted(skills)) or "assistant-setup deploy")
    st = load_json(ch / "settings.json", {}) or {}
    hooked = any(_is_ours(e) for e in st.get("hooks", {}).get("PreToolUse", []))
    from .guard import evaluate
    selftest = evaluate("Bash", {"command": "rm -rf ~"}) is not None and evaluate("Bash", {"command": "rm -rf ~"})[0] == "deny"
    add("Захист (hook)", hooked and selftest, "підключено, самоперевірка пройдена" if hooked and selftest else "assistant-setup deploy")
    sl = "assistant-statusline" in json.dumps(st.get("statusLine", "")) or "assistant_tools.statusline" in json.dumps(st.get("statusLine", ""))
    add("Рядок стану", sl or None, "модель · контекст · ліміти" if sl else "власний або відсутній")
    plan = load_json(assistant_home() / "plan.json")
    add("План для цього ПК", bool(plan), (plan or {}).get("llm", {}).get("label", "assistant-setup plan") if plan else "assistant-setup detect && assistant-setup plan")
    for mark, name, detail in rows:
        print(f"{mark} {name:28} {detail}")
    missing = [r for r in rows if r[0] == "✗"]
    print(f"Підсумок: {len(rows) - len(missing)}/{len(rows)} гаразд" + ("" if not missing else " — див. ✗ вище"))
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="assistant-setup", description="Налаштування універсального помічника Claude.")
    ap.add_argument("--source", help="шлях до папки ai-assistant")
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("detect", help="визначити залізо цього ПК").set_defaults(fn=cmd_detect)
    p = sp.add_parser("plan", help="підібрати локальні моделі та Whisper під цей ПК")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_plan)
    p = sp.add_parser("deploy", help="розгорнути/оновити глобальну конфігурацію Claude")
    p.add_argument("--dry-run", dest="dry_run", action="store_true")
    p.set_defaults(fn=cmd_deploy)
    p = sp.add_parser("undeploy", help="прибрати нашу конфігурацію (з резервною копією)")
    p.add_argument("--dry-run", dest="dry_run", action="store_true")
    p.set_defaults(fn=cmd_undeploy)
    p = sp.add_parser("models", help="локальні моделі Ollama за планом")
    p.add_argument("--pull", action="store_true")
    p.add_argument("--optional", action="store_true", help="також необов'язкові")
    p.set_defaults(fn=cmd_models)
    p = sp.add_parser("backup", help="резервна копія конфігурації без секретів (zip)")
    p.add_argument("--out")
    p.set_defaults(fn=cmd_backup)
    p = sp.add_parser("restore", help="відновити конфігурацію з резервної копії")
    p.add_argument("backup")
    p.add_argument("--dry-run", dest="dry_run", action="store_true")
    p.set_defaults(fn=cmd_restore)
    sp.add_parser("doctor", help="перевірити, що все встановлено і працює").set_defaults(fn=cmd_doctor)
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    a = build_parser().parse_args(argv)
    return int(a.fn(a) or 0)


if __name__ == "__main__":
    sys.exit(main())
