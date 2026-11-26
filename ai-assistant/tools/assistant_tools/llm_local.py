"""llm-local — delegate simple, high-volume tasks to a LOCAL Ollama model.

Privacy: talks only to localhost Ollama and refuses Ollama cloud models (names with "cloud").
Fallback: if Ollama or a suitable model is missing, exits with code 3 and prints
LOCAL_LLM_UNAVAILABLE — the caller (Claude) then does the task itself.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .common import IMAGE_EXT, assistant_home, iter_files, load_json

DEFAULT_HOST = "http://127.0.0.1:11434"
EXIT_UNAVAILABLE = 3
PREFERENCE = {
    "text": ["gemma4", "qwen3.5", "qwen3.6", "qwen3", "gemma3", "mistral", "llama3", "phi4"],
    "vision": ["qwen3.5", "qwen3.6", "gemma4", "qwen3-vl", "gemma3", "qwen2.5vl", "minicpm-v", "llava"],
}
TEXT_EXT = {".txt", ".md", ".srt", ".vtt", ".log", ".csv", ".json", ".html", ".xml", ".yaml", ".yml"}


class Unavailable(RuntimeError):
    pass


def host() -> str:
    h = (os.environ.get("OLLAMA_HOST") or "").strip() or DEFAULT_HOST
    if not h.startswith(("http://", "https://")):
        h = "http://" + h
    return h.replace("0.0.0.0", "127.0.0.1").rstrip("/")


def is_local(url: str) -> bool:
    return (urllib.parse.urlparse(url).hostname or "") in ("127.0.0.1", "localhost", "::1")


def is_cloud(name: str) -> bool:
    return "cloud" in name.lower()


def _req(path: str, payload: dict | None = None, timeout: float = 600.0) -> dict:
    url = host() + path
    if not is_local(url) and os.environ.get("LLM_LOCAL_ALLOW_REMOTE") != "1":
        raise Unavailable(f"OLLAMA_HOST вказує не на цей комп'ютер ({url}) — заборонено політикою приватності")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"},
                                 method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError:
        raise  # handled by callers (e.g. retry without "think")
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise Unavailable(f"Ollama не запущено або недоступна ({host()}): {getattr(e, 'reason', e)}") from e


def installed() -> list[dict]:
    try:
        return [m for m in _req("/api/tags", timeout=5).get("models", []) if not is_cloud(m.get("name", ""))]
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise Unavailable(f"Ollama не запущено або недоступна ({host()}): {getattr(e, 'reason', e)}") from e


def capabilities(name: str) -> set[str]:
    try:
        info = _req("/api/show", {"model": name}, timeout=15)
    except Exception:
        return set()
    caps = set(info.get("capabilities") or [])
    if not caps:
        fams = set((info.get("details") or {}).get("families") or [])
        caps.add("completion")
        if info.get("projector_info") or fams & {"clip", "mllama"}:
            caps.add("vision")
    return caps


def pick_model(need: str = "text", explicit: str | None = None) -> str:
    if explicit:
        if is_cloud(explicit):
            raise Unavailable("хмарні моделі Ollama заборонені (дані пішли б за межі ПК)")
        return explicit
    names = [m["name"] for m in installed()]
    if not names:
        raise Unavailable("локальних моделей немає (assistant-setup models --pull)")
    plan = (load_json(assistant_home() / "plan.json", {}) or {}).get("llm", {})
    wanted = plan.get(need)
    if wanted:
        for n in names:
            if n == wanted or n.split(":")[0] == wanted.split(":")[0] and n.startswith(wanted):
                return n
    for fam in PREFERENCE[need]:
        for n in names:
            if n.split(":")[0] == fam and (need != "vision" or "vision" in capabilities(n)):
                return n
    if need == "vision":
        for n in names:
            if "vision" in capabilities(n):
                return n
        raise Unavailable("немає локальної моделі з підтримкою зображень")
    return names[0]


_THINK = re.compile(r"<think>.*?</think>", re.S)


def chat(model: str, prompt: str, system: str | None = None, images: list[Path] | None = None,
         max_tokens: int = 512, json_mode: bool = False, temperature: float = 0.2, num_ctx: int = 8192) -> str:
    msg: dict = {"role": "user", "content": prompt}
    if images:
        msg["images"] = [base64.b64encode(Path(p).read_bytes()).decode("ascii") for p in images]
    payload: dict = {"model": model, "messages": ([{"role": "system", "content": system}] if system else []) + [msg],
                     "stream": False, "keep_alive": "10m", "think": False,
                     "options": {"num_predict": max_tokens, "temperature": temperature, "num_ctx": num_ctx}}
    if json_mode:
        payload["format"] = "json"
    try:
        r = _req("/api/chat", payload)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
        if e.code == 400 and "think" in body.lower():
            payload.pop("think", None)
            r = _req("/api/chat", payload)
        else:
            raise Unavailable(f"Ollama повернула помилку {e.code}: {body[:200]}") from e
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise Unavailable(f"Ollama недоступна: {e}") from e
    return _THINK.sub("", (r.get("message") or {}).get("content", "")).strip()


def chunks(text: str, size: int = 6000) -> list[str]:
    paras, out, cur = re.split(r"\n\s*\n", text), [], ""
    for p in paras:
        while len(p) > size:
            out.append(p[:size])
            p = p[size:]
        if len(cur) + len(p) + 2 > size and cur:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        out.append(cur)
    return out


# ---------------------------------------------------------------- commands

def cmd_status(a: argparse.Namespace) -> int:
    print(f"Ollama: {host()}")
    try:
        ver = _req("/api/version", timeout=5).get("version")
        models = installed()
    except Unavailable as e:
        print(f"LOCAL_LLM_UNAVAILABLE: {e}")
        return EXIT_UNAVAILABLE
    cloud_off = os.environ.get("OLLAMA_NO_CLOUD") == "1" or bool(
        (load_json(Path.home() / ".ollama" / "server.json", {}) or {}).get("disable_ollama_cloud"))
    print(f"версія {ver}; хмарні функції вимкнено: {'так' if cloud_off else 'НІ (рекомендовано вимкнути)'}")
    for m in models:
        print(f"  {m['name']:28} {m.get('size', 0) / 1e9:5.1f} GB")
    for need in ("text", "vision"):
        try:
            print(f"для «{need}»: {pick_model(need)}")
        except Unavailable as e:
            print(f"для «{need}»: — ({e})")
    return 0


def _read_input(a: argparse.Namespace) -> str:
    text = a.prompt if a.prompt and a.prompt != "-" else sys.stdin.read()
    if getattr(a, "file", None):
        body = Path(a.file).read_text(encoding="utf-8", errors="replace")
        if len(body) > a.max_chars:
            body = body[: a.max_chars] + "\n[…обрізано…]"
        text = f"{text}\n\n---\n{body}"
    return text


def cmd_ask(a: argparse.Namespace) -> int:
    model = pick_model("vision" if a.image else "text", a.model)
    t0 = time.time()
    out = chat(model, _read_input(a), a.system, [Path(p) for p in (a.image or [])], a.max_tokens, a.json)
    print(out)
    if a.stats:
        print(f"[{model}, {time.time() - t0:.1f} с]", file=sys.stderr)
    return 0


def cmd_summarize(a: argparse.Namespace) -> int:
    model = pick_model("text", a.model)
    files = iter_files(a.paths, TEXT_EXT)
    if not files:
        print("Текстових файлів не знайдено.")
        return 1
    lang = "українською" if a.lang == "uk" else f"мовою «{a.lang}»"
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        parts = [chat(model, f"Стисло перекажи {lang} головне з цього фрагмента (факти, числа, імена, рішення):\n\n{c}",
                      max_tokens=400) for c in chunks(text)]
        merged = "\n".join(parts)
        if len(parts) > 1 or len(merged.split()) > a.words * 1.5:
            merged = chat(model, f"Об'єднай нотатки в підсумок до {a.words} слів {lang}, без вигадок:\n\n{merged}",
                          max_tokens=a.words * 3)
        print(f"## {f.name}\n{merged}\n")
    return 0


def cmd_caption(a: argparse.Namespace) -> int:
    model = pick_model("vision", a.model)
    files = iter_files(a.paths, IMAGE_EXT)
    if not files:
        print("Зображень не знайдено.")
        return 1
    prompt = a.prompt or ("Опиши зображення одним реченням українською: що/хто в кадрі, дія, текст на екрані, "
                          "якість (розмито/темно/нормально).")
    out_lines = []
    for f in files:
        line = f"{f.name}: {chat(model, prompt, images=[f], max_tokens=120)}"
        out_lines.append(line)
        print(line)
    if a.save:
        Path(a.save).write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    return 0


def cmd_classify(a: argparse.Namespace) -> int:
    labels = [x.strip() for x in a.labels.split(",") if x.strip()]
    files = iter_files(a.paths, IMAGE_EXT | TEXT_EXT)
    if not labels or not files:
        print("Потрібні --labels і файли.")
        return 2
    vmodel = tmodel = None
    for f in files:
        is_img = f.suffix.lower() in IMAGE_EXT
        if is_img:
            vmodel = vmodel or pick_model("vision", a.model)
        else:
            tmodel = tmodel or pick_model("text", a.model)
        q = (f"{a.prompt or 'Віднеси до однієї категорії.'} Категорії: {', '.join(labels)}. "
             "Відповідь — лише назва категорії.")
        if is_img:
            ans = chat(vmodel, q, images=[f], max_tokens=20)
        else:
            ans = chat(tmodel, q + "\n\n" + f.read_text(encoding="utf-8", errors="replace")[:6000], max_tokens=20)
        low = ans.lower()
        label = next((lab for lab in labels if lab.lower() in low), f"?({ans[:30]})")
        print(f"{f.name}: {label}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="llm-local", description="Прості масові задачі на локальній моделі (Ollama).")
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("status", help="чи працює Ollama, які моделі").set_defaults(fn=cmd_status)
    p = sp.add_parser("ask", help="одне питання (текст або --image)")
    p.add_argument("prompt", nargs="?", default="-")
    p.add_argument("--file")
    p.add_argument("--image", action="append")
    p.add_argument("--system")
    p.add_argument("--model")
    p.add_argument("--max-tokens", dest="max_tokens", type=int, default=512)
    p.add_argument("--max-chars", dest="max_chars", type=int, default=20000)
    p.add_argument("--json", action="store_true")
    p.add_argument("--stats", action="store_true")
    p.set_defaults(fn=cmd_ask)
    p = sp.add_parser("summarize", help="стислий переказ довгих текстів (по шматках)")
    p.add_argument("paths", nargs="+")
    p.add_argument("--words", type=int, default=150)
    p.add_argument("--lang", default="uk")
    p.add_argument("--model")
    p.set_defaults(fn=cmd_summarize)
    p = sp.add_parser("caption", help="опис зображень/кадрів одним рядком")
    p.add_argument("paths", nargs="+")
    p.add_argument("--prompt")
    p.add_argument("--model")
    p.add_argument("--save")
    p.set_defaults(fn=cmd_caption)
    p = sp.add_parser("classify", help="розкласти файли за категоріями")
    p.add_argument("paths", nargs="+")
    p.add_argument("--labels", required=True)
    p.add_argument("--prompt")
    p.add_argument("--model")
    p.set_defaults(fn=cmd_classify)
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    a = build_parser().parse_args(argv)
    try:
        return int(a.fn(a) or 0)
    except Unavailable as e:
        print(f"LOCAL_LLM_UNAVAILABLE: {e}. Виконай задачу без локальної моделі.")
        return EXIT_UNAVAILABLE


if __name__ == "__main__":
    sys.exit(main())
