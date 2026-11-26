"""assistant-statusline — Claude Code status line: model · context fill · 5h/7d plan usage.

Costs zero tokens (runs locally). Reads the status JSON from stdin. Colours: green < 50%, yellow < 80%, red.
"""

from __future__ import annotations

import json
import os
import sys
import time


def _c(pct: float | None) -> str:
    if pct is None or os.environ.get("NO_COLOR"):
        return ""
    return "\033[32m" if pct < 50 else ("\033[33m" if pct < 80 else "\033[31m")


def _pct(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def render(data: dict) -> str:
    reset = "" if os.environ.get("NO_COLOR") else "\033[0m"
    parts = []
    model = (data.get("model") or {}).get("display_name") or (data.get("model") or {}).get("id")
    if model:
        parts.append(str(model))
    ctx = _pct((data.get("context_window") or {}).get("used_percentage"))
    if ctx is not None:
        parts.append(f"контекст {_c(ctx)}{ctx:.0f}%{reset}")
    rl = data.get("rate_limits") or {}
    five = rl.get("five_hour") or {}
    p5 = _pct(five.get("used_percentage"))
    if p5 is not None:
        reset_at = five.get("resets_at")
        when = ""
        if reset_at:
            try:
                when = " до " + time.strftime("%H:%M", time.localtime(float(reset_at)))
            except (TypeError, ValueError, OverflowError):
                when = ""
        parts.append(f"5 год {_c(p5)}{p5:.0f}%{reset}{when}")
    p7 = _pct((rl.get("seven_day") or {}).get("used_percentage"))
    if p7 is not None:
        parts.append(f"7 днів {_c(p7)}{p7:.0f}%{reset}")
    return " │ ".join(parts)


def main() -> int:
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
        line = render(data)
    except Exception:
        line = ""
    sys.stdout.buffer.write(line.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
