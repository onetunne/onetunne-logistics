# FFmpeg-рецепти (коли `mtk` не має готової команди)

Завжди: `-hide_banner -loglevel error`, результат у `_out/`, оригінал не чіпати. Перевір на 1 файлі, потім цикл/`mtk batch`.

## Переходи між кліпами (xfade)
`[0:v][1:v]xfade=transition=fade:duration=0.4:offset=<довжина1-0.4>` + `[0:a][1:a]acrossfade=d=0.4`.
Варіанти: fade, dissolve, wipeleft/right/up/down, slideleft/right/up/down, circleopen/close, radial, smoothleft, zoomin, pixelize, hblur.
(`mtk cut --transition <назва>` робить це автоматично.)

## Текст і графіка
- Текст: `drawtext=fontfile='C\:/Windows/Fonts/arialbd.ttf':text='SALE':x=(w-text_w)/2:y=h*0.12:fontsize=96:fontcolor=white:borderw=6`.
- Поява тексту: `...:alpha='if(lt(t,0.3),t/0.3,1)'`; рух: `y=h*0.2-40*exp(-6*t)`.
- Логотип: `[1:v]scale=160:-1[l];[0:v][l]overlay=W-w-40:40` (`mtk render --logo`).
- Прогрес-бар: `drawbox=x=0:y=ih-12:w=iw*t/<тривалість>:h=12:color=white@0.8:t=fill`.

## Колір
- LUT: `lut3d=file='look.cube'`; яскравість/контраст/насиченість: `eq=brightness=0.03:contrast=1.08:saturation=1.15`.
- Баланс: `colorbalance=rs=0.05:bs=-0.05`; криві: `curves=preset=increase_contrast`; різкість: `unsharp=5:5:0.6`.

## Звук
- Нормалізація: `loudnorm=I=-14:TP=-1.5:LRA=11` (двопрохідна — у `mtk render`).
- Шумопридушення: `afftdn=nf=-25`; обрізати гул: `highpass=f=80`; компресор: `acompressor=threshold=-18dB:ratio=3`.
- Приглушення музики під голос: `[music][voice]sidechaincompress=threshold=0.05:ratio=8[ducked];[ducked][voice]amix=inputs=2`.

## Швидкість, стабілізація, інше
- 2× швидше: `setpts=0.5*PTS` + `atempo=2.0`; сповільнення: `setpts=2*PTS`, `atempo=0.5`.
- Стабілізація (2 проходи): `vidstabdetect=result=t.trf` → `vidstabtransform=input=t.trf:smoothing=20` (або `deshake`).
- GIF: `fps=12,scale=540:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`.
- Мініатюра: `-ss 5 -frames:v 1 thumb.jpg`; найкращий кадр: `thumbnail=300`.

## Апаратне кодування
`mtk doctor` показує робочі кодери. NVIDIA: `-c:v h264_nvenc -preset p5 -cq 21`; Intel: `h264_qsv`; AMD: `h264_amf`.
