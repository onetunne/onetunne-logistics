"""assistant-guard — PreToolUse hook for Claude Code (defence in depth).

stdin: hook JSON ({tool_name, tool_input, ...}). stdout: a permission decision or nothing.
  deny — catastrophic / credential theft (disk wipe, boot config, deleting home or drive roots, ...)
  ask  — risky: deletions outside build/temp folders, system settings, installs, git push/force,
         publishing, uploads, messages/payments/real shipments, reading secret files, editing Claude config
  none — Claude Code's normal permission flow applies.
Works even when the owner uses auto/accept modes. Fail-open on internal errors (warning on stderr);
settings.json permissions.deny is the second layer. Logs only rule ids (no command text, no paths).
Disable in an emergency with env ASSISTANT_GUARD=off (set by the owner, not by commands).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time

from .common import assistant_home

SHELL_TOOLS = {"Bash", "PowerShell"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
READ_TOOLS = {"Read", "Grep"}

R = lambda p: re.compile(p, re.I)  # noqa: E731

DENY_RULES = [
    ("disk-format", R(r"(^|[\s;&|(])(format(\.com)?\s+[a-z]:|format-volume\b|clear-disk\b|initialize-disk\b|"
                      r"remove-partition\b|diskpart\b|mkfs(\.\w+)?\b)"), "Форматування/розмітка дисків"),
    ("boot-config", R(r"\bbcdedit\b"), "Зміна завантажувача Windows"),
    ("shadow-copies", R(r"\bvssadmin\b[^\n]*\bdelete\b|\bwmic\b[^\n]*shadowcopy[^\n]*delete|\bwbadmin\b[^\n]*\bdelete\b"),
     "Видалення резервних копій/тіньових копій"),
    ("wipe", R(r"\bcipher(\.exe)?\s[^\n]*/w\b|\bsdelete\b"), "Незворотне затирання даних"),
    ("raw-disk", R(r"\bdd\b[^\n]*\bof=/dev/|>\s*/dev/(sd|nvme|disk)"), "Запис напряму на диск"),
    ("registry-hklm-delete", R(r"\breg(\.exe)?\s+delete\s+(hklm|hkey_local_machine)|remove-item(property)?\b[^\n]*hklm:"),
     "Видалення системного реєстру"),
    ("security-off", R(r"set-mppreference\b[^\n]*-disable\w*\s+(\$true|1)|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off"),
     "Вимкнення антивірусу/брандмауера"),
    ("fork-bomb", R(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"), "Fork-бомба"),
    ("claude-credentials", R(r"\.credentials\.json"), "Доступ до облікових даних Claude"),
    ("repo-delete", R(r"\bgh\s+repo\s+delete\b"), "Видалення репозиторію GitHub"),
    ("chmod-root", R(r"\bchmod\s+-r\s+[0-7]{3,4}\s+/(\s|$)|\bchown\s+-r\b[^\n]*\s/(\s|$)"), "Зміна прав на весь диск"),
]

ASK_RULES = [
    ("install", R(r"\bwinget\s+(install|uninstall|upgrade|remove|import)\b|\bchoco(latey)?\s+(install|uninstall|upgrade)\b|"
                  r"\bscoop\s+(install|uninstall)\b|\bmsiexec\b|\bapt(-get)?\s+(install|remove|purge|upgrade)\b|"
                  r"\bbrew\s+(install|uninstall|upgrade)\b|\b(npm|pnpm)\s+(i|install|add|uninstall|remove|rm|update)\b[^\n]*\s(-g|--global)\b|"
                  r"\buv\s+tool\s+(install|uninstall)\b|\bpipx\s+(install|uninstall)\b|\bollama\s+(pull|rm)\b"),
     "Встановлення/видалення програм"),
    ("system-settings", R(r"\bset-executionpolicy\b|\bsetx\b|setenvironmentvariable\([^)]*['\"]?(machine|user)|"
                          r"\breg(\.exe)?\s+(add|import|delete|copy|restore)\b|\b(new|set|remove)-itemproperty\b[^\n]*hk(lm|cu):|"
                          r"\bschtasks\b[^\n]*/(create|delete|change)\b|\b(register|unregister|set)-scheduledtask\b|"
                          r"\bsc(\.exe)?\s+(create|config|delete|stop)\b|\b(new|set|stop|remove)-service\b|\bnetsh\b|"
                          r"\bset-net\w*\b|\bnew-netfirewallrule\b|\badd-mppreference\b|\bpowercfg\b|\bicacls\b|\btakeown\b|"
                          r"\bshutdown\b|\brestart-computer\b|\bstop-computer\b|\bcrontab\b|"
                          r"\bsystemctl\s+(enable|disable|stop|mask)\b|\blaunchctl\b"),
     "Зміна системних налаштувань"),
    ("process-kill", R(r"\btaskkill\b|\bstop-process\b|\bkillall\b|\bpkill\b"), "Примусове закриття програм (можлива втрата роботи)"),
    ("git-destructive", R(r"\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|restore\s+--source|branch\s+-d\b|"
                          r"stash\s+(drop|clear)|filter-(branch|repo)|push\s+[^\n]*(--force|-f\b|--delete))"),
     "Незворотна дія з git"),
    ("git-push", R(r"\bgit\s+push\b"), "Відправлення змін на GitHub"),
    ("publish", R(r"\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\buv\s+publish\b|\bdocker\s+push\b|"
                  r"\bgh\s+(release\s+create|pr\s+merge|repo\s+(create|edit|rename))\b|\bshopify\s+app\s+(deploy|release)\b"),
     "Публікація/реліз"),
    ("upload", R(r"\bcurl\b[^\n]*(\s-t\s|--upload-file|\s-f\s|--form\b|\s(-d|--data(-binary|-raw|-urlencode)?)\s+@)|"
                 r"\binvoke-(webrequest|restmethod)\b[^\n]*-infile\b|\b(scp|sftp|rsync)\b[^\n]*\s\S+:\S*|\bftp\b|\bncat?\b"),
     "Надсилання файлів у мережу"),
    ("messages-payments", R(r"api\.telegram\.org|hooks\.slack\.com|discord(app)?\.com/api/webhooks|api\.twilio\.com|"
                            r"api\.sendgrid\.com|api\.mailgun\.net|graph\.facebook\.com|\bsend-mailmessage\b|\bsmtp\b|"
                            r"api\.stripe\.com|api(-m)?\.paypal\.com|liqpay\.ua|api\.monobank\.ua|wayforpay\.com|"
                            r"fondy\.(eu|ua)|novaposhta\.ua|novapost\.com|\.myshopify\.com/admin"),
     "Реальні повідомлення/платежі/накладні/зміни магазину"),
    ("secrets-read", R(r"(\bcat|\btype|get-content|\bgc|\bmore|\bless|\bhead|\btail|\bcopy|\bcp|\bxcopy|\brobocopy|"
                       r"\bselect-string|\bgrep|\brg|\bfindstr|\bsls)\b[^\n]*(\.env\b(?!\.(example|sample|template|dist))|"
                       r"id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.pfx\b|\.p12\b|\.kdbx\b|\.git-credentials|\.npmrc|\.pypirc|"
                       r"\.netrc|\bcredentials\b|login data|\bcookies\b|wallet\.dat|\.aws[/\\]|\.ssh[/\\])"),
     "Читання файлів із секретами"),
    ("env-dump", R(r"^\s*(env|printenv|set)\s*($|\|)|get-childitem\s+env:|\b(gci|ls|dir)\s+env:|"
                   r"\[environment\]::getenvironmentvariables"), "Вивід усіх змінних середовища (можуть містити ключі)"),
    ("self-protect", R(r"(\.claude[/\\]settings(\.local)?\.json|\.claude\.json|assistant[-_]guard)[^\n]*"
                       r"(>|set-content|out-file|add-content|\bsed\s+-i|\bmv\b|\bmove\b|\brm\b|\bdel\b|remove-item)|"
                       r"(>|set-content|out-file|add-content|\bsed\s+-i|\bmv\b|\bmove\b)[^\n]*"
                       r"(\.claude[/\\]settings(\.local)?\.json|\.claude\.json)"),
     "Зміна налаштувань безпеки Claude"),
]

DELETE_PROGS = {"rm", "rmdir", "rd", "del", "erase", "unlink", "remove-item", "ri", "shred"}
SAFE_DIRS = {"node_modules", "dist", "build", "out", ".cache", ".next", ".nuxt", ".turbo", "coverage", "__pycache__",
             ".pytest_cache", ".mypy_cache", ".ruff_cache", "tmp", "temp", ".tmp", "test-results", "playwright-report",
             ".parcel-cache", ".vite", ".react-router", ".svelte-kit", "target", "_out", "_frames", "_sheets",
             "_transcripts", "_trash"}
SAFE_EXT = (".tmp", ".log", ".pyc", ".pyo", ".o", ".obj")
TEMP_PREFIXES = ("/tmp/", "/var/tmp/", "/private/tmp/", "/var/folders/", "%temp%", "$env:temp", "$tmpdir", "${tmpdir}")
ROOT_RE = [R(p) for p in (
    r"^/\*?$", r"^~/?\*?$", r"^\$\{?home\}?/?\*?$", r"^%userprofile%/?\*?$", r"^\$env:userprofile/?\*?$",
    r"^[a-z]:/?\*?$", r"^/[a-z]/?\*?$",
    r"^(/|[a-z]:/|/[a-z]/)(users|home|windows|program files( \(x86\))?|programdata|etc|usr|bin|sbin|boot|system|"
    r"library|var|opt|applications)/?\*?$",
    r"^(~|\$\{?home\}?|%userprofile%|\$env:userprofile|[a-z]:/users/[^/]+|/users/[^/]+|/home/[^/]+)/"
    r"(desktop|documents|downloads|pictures|videos|music|onedrive[^/]*|\.claude)/?\*?$",
    r"^(c:/users/[^/]+|/users/[^/]+|/home/[^/]+)/?\*?$",
    r"^\.\.(/\.\.)*/?\*?$",
)]
RECURSIVE_FLAGS = re.compile(r"^(-[a-z]*r[a-z]*|--recursive|/s|-recurse)$", re.I)
SEPARATORS = re.compile(r"\|\||&&|[;|\n]|(?<![>&])&(?![>&])")
TOKEN = re.compile(r'"[^"]*"|\'[^\']*\'|\S+')
WRAPPERS = {"sudo", "command", "call", "&", "start", "nohup", "time", "xargs", "exec", "doas", "cmd", "/c", "cmd.exe",
            "powershell", "pwsh", "powershell.exe", "pwsh.exe", "-command", "-c", "-noprofile", "-nologo"}


def _norm(t: str) -> str:
    t = t.strip().strip("'\"").replace("\\", "/").lower()
    if len(t) > 1 and t.endswith("/") and not re.fullmatch(r"[a-z]:/", t):
        t = t.rstrip("/")
    return t


def _abs_like(n: str) -> bool:
    return n.startswith(("/", "~", "$", "%", "//")) or bool(re.match(r"^[a-z]:", n))


def _safe_target(n: str) -> bool:
    if n.startswith(TEMP_PREFIXES) or "/appdata/local/temp/" in n:
        return True
    if _abs_like(n):
        return False
    parts = [x for x in n.split("/") if x not in ("", ".")]
    if not parts or ".." in parts:
        return False
    if len(parts) == 1 and any(ch in parts[0] for ch in "*?") and not parts[0].endswith(SAFE_EXT):
        return False
    return any(p in SAFE_DIRS for p in parts[:-1] + [parts[-1]]) or parts[-1].endswith(SAFE_EXT)


def _tokens(part: str) -> list[str]:
    toks = [t.strip("'\"") for t in TOKEN.findall(part)]
    while toks and (toks[0].lower() in WRAPPERS or re.match(r"^\w+=", toks[0])):
        toks.pop(0)
    return toks


def check_deletion(cmd: str) -> tuple[str, str, str] | None:
    verdict = None
    for part in SEPARATORS.split(cmd):
        toks = _tokens(part)
        if not toks:
            continue
        prog = os.path.basename(toks[0].lower().replace("\\", "/"))
        prog = prog[:-4] if prog.endswith(".exe") else prog
        if prog == "find" and any(t in ("-delete", "rm", "-exec") for t in toks[1:]):
            if "-delete" in toks or "rm" in toks:
                verdict = verdict or ("ask", "delete", "Масове видалення через find — підтвердіть")
            continue
        if prog not in DELETE_PROGS:
            continue
        args = toks[1:]
        recursive = any(RECURSIVE_FLAGS.match(x) for x in args)
        targets = [x for x in args if not (x.startswith("-") or re.fullmatch(r"/[a-z](:\S*)?", x, re.I))]
        if not targets:
            verdict = verdict or ("ask", "delete", "Видалення без явного шляху (з конвеєра) — підтвердіть")
            continue
        norm = [_norm(t) for t in targets]
        roots = [t for t in norm if any(rx.match(t) for rx in ROOT_RE)]
        if roots:
            if recursive or prog in ("rd", "rmdir", "remove-item", "ri"):
                return ("deny", "delete-root", f"Видалення кореневої/домашньої/системної папки: {', '.join(roots[:3])}")
            verdict = ("ask", "delete", f"Видалення в кореневій/домашній папці: {', '.join(roots[:3])}")
            continue
        unsafe = [t for t in norm if not _safe_target(t)]
        if unsafe:
            shown = ", ".join(unsafe[:3]) + (" …" if len(unsafe) > 3 else "")
            verdict = verdict or ("ask", "delete", f"Видалення файлів ({shown}) — підтвердіть. Безпечніше: перемістити в _trash")
    return verdict


def check_shell(cmd: str) -> tuple[str, str, str] | None:
    for rid, rx, why in DENY_RULES:
        if rx.search(cmd):
            return ("deny", rid, why)
    d = check_deletion(cmd)
    if d and d[0] == "deny":
        return d
    for rid, rx, why in ASK_RULES:
        if rx.search(cmd):
            return ("ask", rid, why + " — потрібне підтвердження власника")
    return d


SYSTEM_DIR = R(r"^(c:/windows/|c:/program files( \(x86\))?/|c:/programdata/microsoft/|/etc/|/usr/|/bin/|/sbin/|"
               r"/boot/|/system/|/private/etc/|/library/(?!application support/claude))")


def _path_norm(p: str) -> str:
    n = p.replace("\\", "/").lower()
    m = re.match(r"^/([a-z])/", n)
    return f"{m.group(1)}:/" + n[3:] if m else n


def _secret_file(n: str) -> bool:
    name = n.rsplit("/", 1)[-1]
    if re.fullmatch(r"\.env(\.[\w.-]+)?", name) and not re.search(r"\.(example|sample|template|dist)$", name):
        return True
    if name.endswith((".pem", ".key", ".pfx", ".p12", ".jks", ".keystore")):
        return True
    if name in {".git-credentials", ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json",
                "service-account.json", "secrets.json", "secrets.yaml", "secrets.yml"}:
        return True
    return "/.aws/credentials" in n or n.endswith("/gh/hosts.yml") or n.endswith("/.docker/config.json")


def check_file(tool: str, inp: dict) -> tuple[str, str, str] | None:
    p = inp.get("file_path") or inp.get("notebook_path") or inp.get("path") or ""
    if not p:
        return None
    n = _path_norm(str(p))
    name = n.rsplit("/", 1)[-1]
    if name == ".credentials.json" and "/.claude" in n:
        return ("deny", "claude-credentials", "Облікові дані Claude недоступні")
    if re.search(r"/\.ssh/id_[^/]*$", n) and not n.endswith(".pub"):
        return ("deny", "ssh-key", "Приватний SSH-ключ")
    if name.endswith(".kdbx") or name in ("login data", "cookies", "wallet.dat"):
        return ("deny", "vault", "Сховище паролів/кукі браузера")
    if tool in WRITE_TOOLS:
        if SYSTEM_DIR.match(n):
            return ("deny", "system-dir", "Запис у системну папку")
        if n.endswith(("/.claude/settings.json", "/.claude/settings.local.json", "/.claude.json")) or "assistant_tools/guard" in n:
            return ("ask", "self-protect", "Зміна налаштувань Claude/захисту — потрібне підтвердження власника")
        if name in ("microsoft.powershell_profile.ps1", "profile.ps1", ".bashrc", ".bash_profile", ".zshrc", ".profile") \
                or n.endswith("/drivers/etc/hosts"):
            return ("ask", "shell-profile", "Зміна профілю оболонки/hosts — потрібне підтвердження")
    if _secret_file(n):
        return ("ask", "secrets", "Файл із секретами — потрібне підтвердження власника")
    return None


def evaluate(tool: str, inp: dict) -> tuple[str, str, str] | None:
    if tool in SHELL_TOOLS:
        return check_shell(str(inp.get("command") or ""))
    if tool in WRITE_TOOLS or tool in READ_TOOLS:
        return check_file(tool, inp)
    return None


def _log(decision: str, rule: str, tool: str) -> None:
    try:
        d = assistant_home() / "logs"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "guard.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {decision} {rule} {tool}\n")
    except OSError:
        pass


def main() -> int:
    if os.environ.get("ASSISTANT_GUARD", "").lower() == "off":
        return 0
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
        tool = str(data.get("tool_name") or "")
        res = evaluate(tool, data.get("tool_input") or {})
        if res:
            decision, rule, why = res
            _log(decision, rule, tool)
            out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                          "permissionDecisionReason": f"[захист: {rule}] {why}"}}
            sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))
        return 0
    except Exception as e:  # fail-open, but say so
        print(f"assistant-guard: внутрішня помилка ({e.__class__.__name__}); перевірку пропущено", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
