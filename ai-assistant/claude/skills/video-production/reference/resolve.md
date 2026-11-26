# DaVinci Resolve Studio: MCP і скриптовий API

## Вбудований MCP (Resolve Studio 21.1+, вересень 2026)
- Лише Studio. Налаштування: File → Setup AI Assistants → обрати Claude Code та/або Claude Desktop (Resolve сам пропише сервер).
- Довідка: Help → Reference Manual, розділ «Using DaVinci Resolve with AI Assistants».
- Призначення: аналіз проєктів, організація медіа, зміна налаштувань, рендер кількох файлів, хайлайт-монтаж.
- Якщо вбудованого бракує — спільнотний `samuelgursky/davinci-resolve-mcp` (MIT). Не тримай обидва увімкненими одночасно.

## Коли писати скрипт замість MCP
Сотні однотипних операцій (імпорт, створення таймлайнів, маркери, рендер-черга): один виклик скрипта ≈ кілька сотень
токенів, а сотні викликів MCP — десятки тисяч. Готові команди: `mtk resolve info|presets|import-media|import-timeline|markers|render`.
Статус: `mtk resolve` написано за документованим API і ще не перевірено на реальному Resolve — перший запуск роби з `info`.

## Підключення до API (Python, Resolve має бути запущений)
- Resolve: Preferences → System → General → External scripting using: **Local**.
- Windows: `RESOLVE_SCRIPT_API=%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting`,
  `RESOLVE_SCRIPT_LIB=C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll`, модулі — `%RESOLVE_SCRIPT_API%\Modules`.
- Офіційна довідка API для твоєї версії: `%RESOLVE_SCRIPT_API%\README.txt` (читай `grep`-ом потрібний метод, не цілком).
- З Resolve 21.1 Python-скриптинг — лише в Studio; 21.1.1 додав асинхронні виклики.

```python
from assistant_tools.resolve_bridge import connect
resolve = connect()
proj = resolve.GetProjectManager().GetCurrentProject()
mp = proj.GetMediaPool()
items = mp.ImportMedia([r"D:\video\a.mp4", r"D:\video\b.mp4"])
tl = mp.CreateTimelineFromClips("Ad v1", items)
proj.LoadRenderPreset("YouTube - 1080p")
proj.SetRenderSettings({"TargetDir": r"D:\video\_out", "CustomName": "ad_v1"})
job = proj.AddRenderJob(); proj.StartRendering([job])
```
Ключові методи (перевіряй наявність у README.txt своєї версії): `MediaPool.ImportMedia`, `AppendToTimeline`
(з `startFrame`/`endFrame`), `CreateTimelineFromClips`, `ImportTimelineFromFile` (otio/fcpxml/edl/aaf),
`Timeline.AddMarker`, `Project.LoadRenderPreset/SetRenderSettings/AddRenderJob/StartRendering/GetRenderJobStatus`,
`TimelineItem.SetLUT`, `SetCDL`, Fusion: `TimelineItem.GetFusionCompByIndex`.

## Обмеження API
- Переходи й ключові кадри напряму не додаються: переходи — через імпорт таймлайну (OTIO/EDL з dissolve), анімація — Fusion-композиції.
- AI-функції Studio (транскрипція, субтитри, Smart Reframe, Voice Isolation, Magic Mask) — в інтерфейсі; частина доступна з API залежно від версії.
