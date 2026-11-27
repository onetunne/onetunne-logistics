/**
 * Сканування камерою (BarcodeDetector) — коли зараховувати код (чиста логіка, без браузера; використовує екран
 * пакування). Камера бачить той самий штрихкод у кожному кадрі (~3 кадри за секунду), а штрихкоди всіх одиниць
 * варіанта однакові: сервер не відрізнить повторне зчитування тієї самої одиниці від наступної. Тому одна
 * одиниця = одне свідоме зчитування:
 * - код зараховується, коли він ОДИН у кадрі й «озброєний» (новий або повернувся в кадр);
 * - після зарахування код «роззброюється»: доки він лишається в кадрі, його не зараховано знову (стан held —
 *   «приберіть товар з кадру або натисніть „Наступна одиниця"»). Знову озброюється, коли його не було в кадрі
 *   щонайменше absentFrames кадрів поспіль І щонайменше absentMs (поодинокі пропуски розпізнавання не рахуються),
 *   або явною дією пакувальника (rearm — кнопка «Наступна одиниця»);
 * - той самий код повторно — не раніше ніж через sameCodeCooldownMs після попереднього зарахування (навіть якщо він
 *   «зник» на кілька кадрів), крім явного rearm;
 * - після будь-якого зарахування — пауза debounceMs для всіх кодів (два різні коди в кадрі по черзі, напр. товар і
 *   етикетка, не зараховуються миттєво один за одним);
 * - кадр із кількома РІЗНИМИ кодами не зараховується (multiple: «тримайте в кадрі один штрихкод»).
 */

export interface CameraGateOptions {
  /** Пауза для всіх кодів після зарахування, мс. */
  debounceMs?: number;
  /** Найменший час між зарахуваннями того самого коду, мс (без явного rearm). */
  sameCodeCooldownMs?: number;
  /** Кадрів поспіль без коду, після яких він вважається прибраним із кадру. */
  absentFrames?: number;
  /** І не менше ніж стільки мс без коду. */
  absentMs?: number;
}

export const CAMERA_GATE_DEFAULTS: Required<CameraGateOptions> = {
  debounceMs: 800,
  sameCodeCooldownMs: 1500,
  absentFrames: 3,
  absentMs: 900,
};

export type CameraFrameResult =
  /** Зарахувати код (надіслати на сервер). */
  | { kind: "emit"; code: string }
  /** Той самий код усе ще в кадрі (уже зараховано) — приберіть товар або «Наступна одиниця». */
  | { kind: "held"; code: string }
  /** Кілька різних кодів у кадрі — не зараховано. */
  | { kind: "multiple"; count: number }
  /** Пауза після попереднього зарахування. */
  | { kind: "wait"; code: string }
  /** У кадрі немає коду. */
  | { kind: "none" };

interface CodeState {
  lastSeenAt: number;
  absentFrames: number;
  armed: boolean;
  /** Озброєно явною дією (rearm): без паузи для того самого коду. */
  forced: boolean;
  lastEmitAt: number | null;
}

/** Код скидається зі стану, якщо його не бачили стільки мс (пам'ять не росте під час довгої роботи камери). */
const FORGET_AFTER_MS = 60_000;

export class CameraScanGate {
  private readonly opts: Required<CameraGateOptions>;
  private readonly codes = new Map<string, CodeState>();
  private lastEmitAt: number | null = null;

  constructor(opts: CameraGateOptions = {}) {
    this.opts = { ...CAMERA_GATE_DEFAULTS, ...opts };
  }

  /** Результат розпізнавання одного кадру (rawValue усіх знайдених кодів) у момент now (мс). */
  frame(raw: ReadonlyArray<string | null | undefined>, now: number): CameraFrameResult {
    const present = [...new Set(raw.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0))];
    const seen = new Set(present);
    for (const [code, st] of this.codes) {
      if (seen.has(code)) continue;
      st.absentFrames += 1;
      if (!st.armed && st.absentFrames >= this.opts.absentFrames && now - st.lastSeenAt >= this.opts.absentMs) st.armed = true;
      if (now - st.lastSeenAt > FORGET_AFTER_MS) this.codes.delete(code);
    }
    for (const code of present) {
      const st = this.codes.get(code);
      if (st) {
        st.lastSeenAt = now;
        st.absentFrames = 0;
      } else {
        this.codes.set(code, { lastSeenAt: now, absentFrames: 0, armed: true, forced: false, lastEmitAt: null });
      }
    }
    if (present.length === 0) return { kind: "none" };
    if (present.length > 1) return { kind: "multiple", count: present.length };
    const code = present[0]!;
    const st = this.codes.get(code)!;
    if (!st.armed) return { kind: "held", code };
    if (this.lastEmitAt !== null && now - this.lastEmitAt < this.opts.debounceMs) return { kind: "wait", code };
    if (!st.forced && st.lastEmitAt !== null && now - st.lastEmitAt < this.opts.sameCodeCooldownMs) return { kind: "held", code };
    st.armed = false;
    st.forced = false;
    st.lastEmitAt = now;
    this.lastEmitAt = now;
    return { kind: "emit", code };
  }

  /** «Наступна одиниця»: пакувальник свідомо підносить наступну одиницю з тим самим кодом. */
  rearm(): void {
    for (const st of this.codes.values()) {
      st.armed = true;
      st.forced = true;
    }
  }

  /** Камеру вимкнено/увімкнено знову — стан з нуля. */
  reset(): void {
    this.codes.clear();
    this.lastEmitAt = null;
  }
}
