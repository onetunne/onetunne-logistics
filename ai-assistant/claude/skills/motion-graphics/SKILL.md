---
name: motion-graphics
description: Анімації та ефекти - анімовані заголовки й плашки, лого-ревіли, кінцеві заставки з CTA, переходи, прогрес-бари, анімована інфографіка; Fusion у DaVinci Resolve, Remotion, FFmpeg, Blender. Motion graphics, animated titles, lower thirds, logo reveal, end cards.
# managed-by: universal-assistant
---
# Моушн-графіка

## Вибір інструмента (від найдешевшого)
| Задача | Інструмент |
|---|---|
| Заголовок/плашка з появою, поверх ролика | `mtk render --title "..." --title-dur 3` (ASS, з fade) |
| Субтитри «як у TikTok» | `mtk render --subs auto --style tiktok` |
| Прості рухи тексту, прогрес-бар, лого | FFmpeg `drawtext`/`overlay`/`drawbox` з виразами від `t` (див. video-production/reference/ffmpeg-recipes.md) |
| Анімація всередині проєкту Resolve | Fusion: Text+ / шаблони Effects Library; через вбудований MCP або Fusion-скрипт |
| Серія шаблонних роликів із даних (ціни, назви товарів) | Remotion (React) — **лише після підтвердження ліцензії власником** |
| 3D-товар, лого в 3D | Blender 5.1+ через офіційний конектор/MCP (якщо встановлено) |

## Remotion: ліцензія
Безкоштовно для фізичних осіб і компаній до 3 осіб (рахується весь штат). Більше — платна Company License.
Перед першим використанням спитай власника про розмір команди. Skills: `npx skills add remotion-dev/skills`.
Рендер: `npx remotion render <Composition> out.mp4`; масово — з props JSON (одна композиція → сотні варіантів).

## Fusion (Resolve)
- Text+ з анімацією: Inspector → Keyframes або модифікатори (Follower для побуквенної анімації).
- Скриптом: `item.GetFusionCompByIndex(1)` → `comp.AddTool("TextPlus")`, `tool.SetInput("StyledText", "...")`,
  ключові кадри — через `comp.SetAttrs`/`BezierSpline`. Перевіряй API у Fusion Scripting Guide своєї версії.

## Якість
- Тривалість появи 0.2–0.4 с, ease-out; не більше 2 рухів одночасно; текст тримати ≥ 1.5 с на кожні 3 слова.
- Кирилиця в шрифті обов'язкова; вільні шрифти — OFL (Google Fonts), не вантаж шрифти з невідомих сайтів.
- Прозорість: ProRes 4444 (`-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le`) або PNG-послідовність.
- Безпечні зони вертикалі — див. video-production/reference/platforms.md.
- Перед масовим рендером — 1 перевірочний кадр (`mtk frames`).
