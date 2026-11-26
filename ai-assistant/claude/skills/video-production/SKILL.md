---
name: video-production
description: Монтаж відео - нарізка, склейка, пошук цікавих моментів, рекламні ролики для TikTok/Instagram Reels/YouTube Shorts, субтитри, гучність, колір, експорт, пакетна обробка сотень файлів, DaVinci Resolve (вбудований MCP і API). Video editing, highlights, vertical ads, subtitles, batch rendering, DaVinci Resolve.
# managed-by: universal-assistant
---
# Монтаж відео (локально, економно)

Головне правило: модель не «дивиться» відео покадрово. Усе важке робить `mtk` (FFmpeg + Whisper) на ПК,
у контекст потрапляють таблиці, транскрипт і максимум один контактний аркуш на відео.

## Типовий конвеєр рекламного ролика
1. `mtk probe <папка>` — інвентаризація (сотні файлів → одна таблиця + підсумок).
2. `mtk transcribe <файл|папка> --lang uk` → `_transcripts/<ім'я>.txt` (компактно, з часом), `.srt`, `.json` (слова).
3. `mtk sheet <файл>` → одне зображення 4×4 кадри з часом; дивись його лише за потреби візуальної оцінки.
4. `mtk highlights <файл> --keywords "знижка,новинка" --target 12 --top 8` → кандидати з причинами й текстом.
   Остаточний вибір роби сам за змістом транскрипту (гачок у перші 1–2 с, одна думка, сильний фінал/CTA).
5. Збірка: `mtk cut <файл> --segments "0:12-0:19,1:03-1:10" --transition fade --tdur 0.3 -o _out/ad_v1.mp4`.
6. Готова версія під платформу: `mtk render _out/ad_v1.mp4 --preset tiktok --subs auto --style tiktok --title "ЗНИЖКА -30%" --logo logo.png`.
7. Перевірка: `mtk probe _out` + `mtk frames _out/ad_v1_tiktok.mp4 --at 0:01,0:08`.

## Масова обробка (сотні файлів)
- `mtk batch <папка> --preset reels --subs auto --style tiktok --jobs 2` — спершу транскрипція всіх (одне завантаження моделі), потім рендер паралельно; повторний запуск продовжує з місця зупинки.
- Запускай у фоні; прогрес — `_out/_batch_progress.txt`, помилки — `_out/_batch_log.jsonl` (читай `tail`, не весь файл).
- Спершу перевір 1 файл (`mtk render ... --dry-run`, потім реальний), лише потім усю папку.

## Тихі паузи, «говорячі голови»
- `auto-editor input.mp4 --margin 0.2sec --export resolve` → XML-таймлайн для Resolve без пауз (або `-o out.mp4`).
- `mtk silence input.mp4` — подивитися паузи; `mtk loudness` — гучність і найгучніші моменти.

## DaVinci Resolve Studio
- Інтерактивна робота: вбудований MCP Resolve 21.1+ (налаштування: File → Setup AI Assistants). Добре для: аналізу проєкту, організації медіа, налаштувань, рендеру, хайлайт-монтажу.
- Масові однотипні дії (сотні кліпів/таймлайнів) — НЕ сотні викликів MCP, а один скрипт: `mtk resolve import-media|import-timeline|markers|render|presets|info` або власний Python-скрипт API (див. reference/resolve.md).
- Монтаж «ззовні»: `mtk timeline <джерело> --segments-file _out/x_highlights.json --dissolve 0.5 --edl` → `.otio`/`.edl` → File → Import → Timeline (або `mtk resolve import-timeline`).
- Колір: LUT (`mtk render --lut file.cube` або Resolve), тонка корекція — у Resolve (Color page, вбудовані AI-інструменти Studio).
- Звук: Fairlight/Voice Isolation у Resolve Studio; масово — `loudnorm` у mtk (−14 LUFS).

## Формати платформ
Коротко: вертикаль 1080×1920 (TikTok/Reels/Shorts), YouTube 1920×1080 або 3840×2160, стрічка 1080×1350.
Ліміти тривалості й безпечні зони змінюються — див. reference/platforms.md і перевір перед публікацією.

## Субтитри
- `--style tiktok`: 1–3 слова, поточне слово жовте, великими літерами (потрібні слова з таймінгом — дає `mtk transcribe`).
- `--style clean`: класичні знизу, до 2 рядків.
- Перевір орфографію в `.srt` перед масовим рендером (Whisper помиляється в іменах і брендах); виправ `.json`/`.srt` і рендер підхопить.

## Додатково
- Ефекти/переходи FFmpeg, кольорові й аудіо-фільтри: reference/ffmpeg-recipes.md.
- Анімації, плашки, лого-ревіли: skill `motion-graphics`.
- Опис сотень кадрів/кліпів для сортування — `llm-local caption _sheets/` (skill `local-llm`).
- Авторські права: музика й чужі відео — лише з ліцензією; нагадуй власнику.
