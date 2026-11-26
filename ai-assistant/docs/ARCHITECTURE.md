# Архітектура універсального помічника Claude (станом на 26.11.2026)

## 1. Схема

```
Ви: текст, голос (/voice українською), скріншоти, Remote Control з телефона
            │
Claude Desktop (вкладки Code / Cowork, Computer Use, конектори)  або  Claude Code в терміналі
            │   глобальна конфігурація ~/.claude (однакова на будь-якому ПК):
            │   правила · 6 skills (знання на вимогу) · 5 агентів · захисний хук · рядок стану
            │
   ┌────────┼───────────────────────────────┬──────────────────────────────────────┐
   │ Локальні інструменти (обробка = 0 токенів)  │ Програми через MCP/конектори      │ Браузер і екран
   │ mtk: FFmpeg + Whisper + Resolve API         │ DaVinci Resolve 21.1 (вбудований) │ Claude in Chrome
   │ auto-editor · llm-local (Ollama)            │ Blender · Affinity (за бажанням)  │ Computer Use — крайній випадок
   │ playwright-cli · gh · ctx7                  │                                   │
   └─────────────────────────────────────────────┴───────────────────────────────────┴──────────────
Переносимість: папка ai-assistant (git або ZIP) → install.cmd на новому ПК → restore.cmd з бекапу без секретів
```

Принцип: **Claude думає і керує, локальні програми виконують важку роботу.** У контекст моделі потрапляють лише
компактні результати (таблиці, транскрипти, списки кандидатів, один контактний аркуш), а не відео, кадри чи журнали.

## 2. Інструменти: що ставимо і навіщо

### Обов'язкові
| Інструмент | Ліцензія | Що дає | Вплив на токени |
|---|---|---|---|
| Claude Code (CLI) + Claude Desktop | у підписці | агент, що виконує дії; Desktop — Computer Use на Windows, Cowork, конектори | — |
| Git for Windows | GPL-2.0 | Bash для Claude Code, синхронізація конфігурації | нейтрально |
| uv (Python 3.12) | MIT/Apache | ізольоване встановлення наших утиліт | нейтрально |
| FFmpeg (збірка Gyan) | GPL | уся обробка відео/аудіо локально | **економить** |
| assistant-tools (наш код): `mtk`, `llm-local`, захист, рядок стану, бекап; Whisper (faster-whisper, MIT) | MIT | готові перевірені команди; транскрипція | **економить** |

### Рекомендовані
| Інструмент | Ліцензія | Навіщо | Вплив на токени |
|---|---|---|---|
| DaVinci Resolve Studio 21.1+ — **вбудований офіційний MCP** | у вашій ліцензії Studio | керування проєктом, медіа, рендером з Claude | розширює (кожна дія — виклик) |
| Auto-Editor | Unlicense | вирізання пауз, експорт таймлайну в Resolve | **економить** |
| Claude in Chrome | у підписці | сайти, де ви вже увійшли (Shopify, пошта, соцмережі) | розширює (помірно) |
| Playwright CLI + skill (Microsoft) | Apache-2.0 | автоматизація браузера, тести | **економить** проти Playwright MCP |
| GitHub CLI `gh` | MIT | GitHub без важкого MCP | **економить** проти GitHub MCP |
| Context7 (`ctx7` CLI + skill) | MIT, безкоштовний ключ | актуальна документація бібліотек для розробки | економить спроби й помилки |
| Ollama + модель за залізом | MIT | безкоштовні масові прості задачі на ПК | **економить** на масових задачах |
| Голос `/voice` у Claude Code | у підписці | диктування українською; розпізнавання не витрачає токенів | нейтрально |

### Необов'язкові (ставити, коли з'явиться задача)
| Інструмент | Ліцензія | Коли |
|---|---|---|
| Blender 5.1+ з офіційним MCP/конектором (Blender Lab, з квітня 2026) | GPL | 3D товарів і лого |
| Affinity by Canva (безкоштовний) + конектор Claude | безкоштовно | ручний графічний дизайн |
| Remotion + офіційні skills | безкоштовно лише для фізособи/компанії ≤ 3 осіб, інакше від $25/місце/міс | серії анімованих роликів із даних |
| Handy (офлайн-диктування) | MIT | голос у будь-якій програмі без інтернету |
| ImageMagick | вільна | пакетна обробка зображень |
| Спільнотний `davinci-resolve-mcp` (v5.5, MIT) | MIT | лише якщо вбудованого MCP Resolve бракує |

### Не рекомендовано (дублює або шкодить)
| Що | Чому |
|---|---|
| GitHub MCP | дублює `gh`, але додає багато описів інструментів і об'ємний JSON |
| Playwright MCP | той самий Playwright, але вивід в рази більший; Microsoft сама радить CLI+skills для агентів |
| Windows-MCP (спільнотний) | повне керування Windows стороннім сервером; є офіційний Computer Use |
| Claude Code на моделях Ollama (`ollama launch claude`) | Anthropic офіційно не підтримує; якість різко нижча |
| Проксі-маршрутизатори (claude-code-router тощо) | перехоплюють увесь трафік і ключі |

## 3. Що справді економить ліміти, а що лише розширює можливості

**Справді економлять** (ті самі задачі — у рази менше токенів):
- **Локальна обробка медіа** (`mtk`, FFmpeg, Whisper, auto-editor). Монтаж 300 файлів = одна команда і підсумок
  (≈1–2 тис. токенів) замість сотень окремих дій (100+ тис.).
- **Компактні «очі»**: один контактний аркуш 4×4 кадри ≈ 600–1300 токенів замість 16 окремих кадрів (≈15–25 тис.);
  транскрипт 10-хвилинного відео ≈ 3–4 тис. токенів і дає зміст, якого кадри не дають.
- **Скрипт замість сотні викликів MCP** (Resolve: `mtk resolve …`).
- **CLI замість MCP** (`gh`, `playwright-cli`, `ctx7`) — коротший вивід, немає важких схем інструментів.
- **llm-local**: опис 500 кадрів локальною моделлю — 0 токенів Claude на обробку, ≈10 тис. на читання результатів
  замість ≈400 тис. на перегляд зображень.
- **Skills замість великого CLAUDE.md**: поки skill не потрібен, у контексті лише його опис (~100 токенів).
- **Агенти на дешевшій моделі (Sonnet)** для пошуку/монтажу/перевірки; найсильніша модель (Opus) — лише для аудиту безпеки.
- **Рядок стану** (0 токенів): видно заповнення контексту і ліміти 5 год/7 днів — вчасно `/compact` чи `/clear`.
- **Обмеження виводу команд** (`BASH_MAX_OUTPUT_LENGTH=20000`) і правило «довгий вивід — у файл».

**Розширюють можливості** (коштують токенів при використанні, але дають нове):
MCP DaVinci Resolve, Blender, Affinity; Claude in Chrome (помірно); **Computer Use — найдорожчий** (скріншот на кожен крок),
тому лише коли немає іншого шляху; Remotion; Context7 (додає документацію в контекст, але зменшує помилки).

**Нейтральні**: Git, uv, Node.js, голосове введення (`/voice` не витрачає токенів), бекап, захисний хук.

## 4. Агенти: чому 5, а не 9

Агент — це окрема сесія з власним контекстом: він **витрачає ліміти**, але не засмічує основну розмову.
Тому агент виправданий лише там, де багато читання/виводу або потрібна незалежність. Решта ролей — **skills**
(знання, що підвантажуються лише за потреби).

| Роль | Реалізація | Модель | Чому так |
|---|---|---|---|
| Developer | основна сесія Claude Code | ваша поточна | Claude Code і є розробником; окремий агент лише дублював би контекст |
| Researcher | агент `researcher` | Sonnet | читає десятки сторінок, повертає 300 слів із джерелами |
| Video Editor | агент `video-editor` + skill `video-production` | Sonnet | довгі пакети й журнали не потрапляють в основний контекст |
| Motion Designer | агент `motion-designer` + skill `motion-graphics` | Sonnet | рендер і код анімацій — багато виводу |
| Quality Control | агент `quality-control` (тільки читання) | Sonnet | незалежна перевірка, не «перевіряє сам себе» |
| Security Expert | агент `security-expert` (тільки читання) | Opus | рідко, але помилка дорога |
| Graphic Designer | skill `graphic-design` | — | дизайн — діалог із вами, краще в основній сесії |
| Automation Expert | skill `automation` | — | правила безпечних скриптів; виконує основна сесія |
| Business Assistant | skill `business-assistant` | — | листи, ціни, аналіз — діалог із вами |

Модель **Fable** (найпотужніша) у конфігурації не використовується: за документацією вона може списувати платні кредити.

## 5. Локальні моделі та залізо

`assistant-setup detect` визначає ОЗП, відеокарту (VRAM), процесор, диск; `assistant-setup plan` підбирає:

| ПК | Локальна модель | Whisper | Кодування відео |
|---|---|---|---|
| < 16 ГБ ОЗП, без відеокарти | немає (Claude працює без неї) | medium на CPU | CPU / Intel QSV |
| ≥ 16 ГБ ОЗП, без відеокарти | qwen3.5:4b (текст+зображення) | turbo на CPU (8+ потоків) | CPU / QSV |
| відеокарта 8–15 ГБ | qwen3.5:9b | large-v3-turbo на NVIDIA | NVENC / AMF |
| 16–23 ГБ + 32 ГБ ОЗП | qwen3.5:9b + за бажанням gemma4:26b | large-v3-turbo | NVENC / AMF |
| ≥ 24 ГБ | gemma4:26b + qwen3.5:9b | large-v3-turbo | NVENC / AMF |

Якщо тег моделі зміниться, береться альтернатива з `config/models.json`. Хмарні моделі Ollama заборонені,
хмарні функції Ollama вимикаються (`disable_ollama_cloud`). Якщо Ollama немає — `llm-local` повертає код 3,
і Claude просто робить задачу сам.

## 6. Безпека (кілька рівнів)
1. **Правила** в `~/.claude/rules/universal-assistant.md`.
2. **Захисний хук `assistant-guard`** перед кожною дією, навіть в автоматичних режимах:
   - забороняє: форматування дисків, зміну завантажувача, видалення кореня/домашньої/системних папок, вимкнення антивірусу,
     доступ до облікових даних Claude і приватних SSH-ключів, видалення репозиторіїв;
   - питає вас: видалення файлів поза папками збірки/тимчасовими, встановлення програм, системні налаштування,
     `git push`, публікацію, надсилання файлів у мережу, повідомлення/платежі/накладні/зміни магазину, читання `.env`.
3. **Дозволи** в `settings.json` (другий рубіж).
4. **Резервні копії**: кожне розгортання спершу зберігає ваші файли; бекап конфігурації — без паролів, токенів і ключів
   (перевіряється сканером секретів, інакше бекап не створюється).

## 7. Джерела (перевірено 26.11.2026)
- Resolve 21.1 з MCP: [Digital Production](https://digitalproduction.com/2026/09/08/resolve-21-1-adds-mcp-and-finally-gets-presets/),
  [YMCinema](https://ymcinema.com/2026/09/17/davinci-resolve-21-1-mcp-ai-assistants-control-edit/),
  [Blackmagic](https://www.blackmagicdesign.com/media/partial/release/20260908-03), 21.1.1: [Digital Production](https://digitalproduction.com/2026/10/06/davinci-resolve-21-1-1/)
- Спільнотний Resolve MCP: [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp)
- Конектори Blender/Adobe/Affinity: [Anthropic](https://www.anthropic.com/news/claude-for-creative-work), [9to5Mac](https://9to5mac.com/2026/04/28/anthropic-releases-9-new-claude-connectors-for-creative-tools-including-blender-and-adobe/)
- Playwright CLI: [playwright.dev](https://playwright.dev/agent-cli/introduction), порівняння: [Checkly](https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/)
- Ollama й Claude Code: [docs.ollama.com](https://docs.ollama.com/integrations/claude-code); вимкнення хмари: [Ollama FAQ](https://docs.ollama.com/faq)
- Remotion ліцензія: [remotion.dev](https://www.remotion.dev/docs/license)
- Computer Use на Windows: [Thurrott](https://www.thurrott.com/a-i/anthropic/334498/anthropic-brings-claude-computer-use-to-windows)
- Handy: [cjpais/Handy](https://github.com/cjpais/Handy); Parakeet v3 (українська): [NVIDIA](https://build.nvidia.com/nvidia/parakeet-tdt-0_6b/modelcard)
- Claude Code (налаштування, хуки, агенти, skills, /voice, Chrome): [code.claude.com/docs](https://code.claude.com/docs)
- Моделі Gemma 4 / Qwen 3.5 в Ollama: [ollama.com/library/gemma4](https://ollama.com/library/gemma4), [порівняння](https://www.mindstudio.ai/blog/gemma-4-vs-qwen-3-5-open-weight-comparison)
