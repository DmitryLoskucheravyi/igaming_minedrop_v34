/* ============================================================
   AUDIO — фонова музика. Єдина звукова система в проєкті; до цього
   гра була німа.

   ЧОМУ HTMLAudioElement, А НЕ WEB AUDIO
   Задача рівно одна: крутити один зациклений трек із постійною
   гучністю. Web Audio дає мікшер, ефекти й семплову точність — нічого
   з цього тут не потрібно, а коштує воно окремим AudioContext, який у
   вебв'ю телеграма ще й треба окремо «розбуджувати». Один <audio> з
   loop = true робить те саме двома рядками.

   АВТОПЛЕЙ ЗАБОРОНЕНИЙ
   Жоден браузер не дасть заграти до першого ЖЕСТУ користувача, і
   .play() поверне відхилений Promise. Тому:
     - трек стартує з першого pointerdown по канвасу (одноразовий
       слухач, див. arm());
     - відмову play() ковтаємо мовчки. Це не помилка й не баг: це
       нормальна відповідь браузера, і сипати нею в консоль — значить
       ховати в шумі справжні помилки.

   ВАГА
   Файл ~1.6 МБ. Вантажити його до першого кадру — рівно те, від чого
   застерігає шапка assets.ts, тому елемент створюється з
   preload='none', а фактичне завантаження вмикає prefetch(), який
   презентер кличе ПІСЛЯ першого намальованого кадру.

   ФОРМАТ
   .ogg не грає в Safari/iOS взагалі. Тому джерело вибирається через
   canPlayType, а не задається жорстко: як тільки з'явиться .m4a/.mp3,
   досить дописати рядок у SOURCES. Поки що на iOS музики не буде — і
   це нормальний стан, а не поломка: не вибралось жодне джерело —
   модуль просто мовчить.
   ============================================================ */

const SOURCES: readonly { src: string; type: string }[] = [
  { src: '/audio/music-background.ogg', type: 'audio/ogg' },
  // сюди ж .m4a / .mp3, коли з'являться — порядок задає пріоритет
];

/** Тихо: музика тлом, а не подією. */
const VOLUME = 0.35;
const STORAGE_KEY = 'minedrop.muted';

function loadMuted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;   // приватний режим — просто зі звуком
  }
}

function saveMuted(v: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
  } catch { /* приватний режим — стан просто не переживе перезавантаження */ }
}

class MusicPlayer {
  private el: HTMLAudioElement | null = null;
  private muted = false;
  private started = false;
  private target: HTMLElement | null = null;
  private loaded = false;

  /* Створюємо елемент і чіпляємо одноразовий слухач жесту. Викликати
     після монтування канваса. Сам трек ще не вантажиться. */
  arm(target: HTMLElement): void {
    if (typeof window === 'undefined' || this.el) return;
    this.muted = loadMuted();

    const el = document.createElement('audio');
    const pick = SOURCES.find((s) => el.canPlayType(s.type) !== '');
    if (!pick) return;                 // формат не підтримується (iOS) — мовчимо

    el.src = pick.src;
    el.loop = true;
    el.volume = VOLUME;
    el.preload = 'none';
    this.el = el;

    this.target = target;
    target.addEventListener('pointerdown', this.onGesture, { once: true });
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /* Реальне завантаження — після першого кадру гри, не раніше. */
  prefetch(): void {
    if (!this.el || this.loaded) return;
    this.loaded = true;
    this.el.preload = 'auto';
    this.el.load();
  }

  private onGesture = () => {
    this.started = true;
    this.play();
  };

  /* Вкладка згорнулась — трек на паузу. Без цього в телеграмі музика
     грає у згорнутому застосунку. */
  private onVisibility = () => {
    if (!this.el) return;
    if (document.hidden) this.el.pause();
    else this.play();
  };

  private play(): void {
    if (!this.el || this.muted || !this.started || document.hidden) return;
    this.prefetch();
    // відхилення тут — штатна відповідь браузера, а не помилка
    void this.el.play().catch(() => { /* автоплей заборонений — чекаємо жест */ });
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Перемикає звук і повертає НОВИЙ стан (true — вимкнено). */
  toggle(): boolean {
    this.muted = !this.muted;
    saveMuted(this.muted);
    if (this.muted) this.el?.pause();
    else {
      /* Тап по кнопці — теж жест, тож можна стартувати навіть якщо по
         полю ще не клікали: гравець, який вмикає звук, явно цього
         хоче. */
      this.started = true;
      this.play();
    }
    return this.muted;
  }

  dispose(): void {
    this.target?.removeEventListener('pointerdown', this.onGesture);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.el?.pause();
    this.el = null;
    this.target = null;
    this.started = false;
    this.loaded = false;
  }
}

export const Music = new MusicPlayer();
