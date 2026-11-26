"""Redaction of secrets for backups: JSON-aware (by key name) + pattern-based (known token formats)."""

from __future__ import annotations

import re
from typing import Any

SECRET_KEY = re.compile(r"(token|secret|passw(or)?d|api[_-]?key|apikey|auth|bearer|cookie|session|private[_-]?key|"
                        r"client[_-]?secret|credential|access[_-]?key|^pat$|_pat$)", re.I)
SAFE_KEYS = {"autoUpdates", "autoUpdaterStatus", "authMethod"}  # booleans/enums that only look sensitive

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")),
    ("anthropic", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("openai", re.compile(r"\bsk-(proj-)?[A-Za-z0-9_\-]{32,}")),
    ("github", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})")),
    ("slack", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}")),
    ("aws", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("google", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("shopify", re.compile(r"\bshp(at|ss|ca|pa)_[a-fA-F0-9]{32}\b")),
    ("telegram-bot", re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b")),
    ("npm", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("huggingface", re.compile(r"\bhf_[A-Za-z0-9]{30,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/\-]{16,}=*")),
    ("kv-secret", re.compile(r"(?i)\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['\"]?[^\s'\"<>]{8,}")),
]
ARG_FLAG = re.compile(r"(?i)^--?(api[-_]?key|token|secret|password|auth|access[-_]?token)(=(.*))?$")


def redact_text(s: str) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {}
    for name, rx in PATTERNS:
        s, n = rx.subn(f"<REDACTED:{name}>", s)
        if n:
            counts[name] = counts.get(name, 0) + n
    return s, counts


def _merge(a: dict[str, int], b: dict[str, int]) -> None:
    for k, v in b.items():
        a[k] = a.get(k, 0) + v


def redact_json(obj: Any) -> tuple[Any, dict[str, int]]:
    counts: dict[str, int] = {}

    def walk(o: Any, key: str | None = None) -> Any:
        if isinstance(o, dict):
            return {k: walk(v, k) for k, v in o.items()}
        if isinstance(o, list):
            out, skip_next = [], False
            for item in o:
                if skip_next and isinstance(item, str):
                    out.append("<REDACTED:arg>")
                    counts["arg"] = counts.get("arg", 0) + 1
                    skip_next = False
                    continue
                skip_next = False
                if isinstance(item, str):
                    m = ARG_FLAG.match(item)
                    if m:
                        if m.group(2):
                            out.append(item.split("=", 1)[0] + "=<REDACTED:arg>")
                            counts["arg"] = counts.get("arg", 0) + 1
                        else:
                            out.append(item)
                            skip_next = True
                        continue
                out.append(walk(item, key))
            return out
        if isinstance(o, str):
            if key and key not in SAFE_KEYS and SECRET_KEY.search(key) and o and not o.startswith("<REDACTED"):
                counts["by-key"] = counts.get("by-key", 0) + 1
                return f"<REDACTED:{key}>"
            s, c = redact_text(o)
            _merge(counts, c)
            return s
        return o

    return walk(obj), counts


def find_secrets(s: str) -> list[str]:
    """Names of patterns still present (used as a final check before writing a backup)."""
    return [name for name, rx in PATTERNS if name != "kv-secret" and rx.search(s)]
