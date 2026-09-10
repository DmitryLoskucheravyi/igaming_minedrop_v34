/* ============================================================
   ЕФЕКТИ — іскри, спливаючі числа, спалахи-картинки й живий лог
   виграшу.

   Чотири списки, які жили полями презентера разом із камерою, мережею
   й станом раунду. Спільного в них із рештою нічого: вони не впливають
   ні на виплату, ні на анімацію кірки — це те, що просто дожовується
   на екрані й гасне. Тому й окремо: кадр ефектів можна крутити,
   дивитись і правити, не відкриваючи решту гри.

   Одиниці — КЛІТИНКИ поля, не пікселі (як і вся фізика). Перевід у
   пікселі робить той, хто малює, бо тільки він знає масштаб.
   ============================================================ */

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  size: number; life: number; color: string;
}

/* money — сума в рублях: рядок будується на льоту під поточну валюту й
   малюється зі значком. prefix — текст перед сумою ('+', 'БУМ! +').
   Якщо money не задано — показуємо просто text. */
export interface Popup {
  x: number; y: number; life: number; text: string;
  color: string; size: number; money?: number; prefix?: string;
}

export interface Toast {
  text: string; color: string; life: number; money?: number;
}

/* Спрайт-спалах: одна картинка, яка живе частку секунди, гасне й
   трохи росте. Саме одна КАРТИНКА, а не анімація — художник дав
   одиночні кадри (вибух TNT, силуети кірки на grow/TNT/верстак), і
   робити з них спрайт-лист нема з чого.

   key    — ключ в Assets ('fx.tntBlast' і т. д.)
   x, y   — центр, у КЛІТИНКАХ поля (як і решта тут)
   size   — ширина на старті, у клітинках
   grow   — у скільки разів виростає до кінця життя
   rot    — поворот у радіанах (шлейф орієнтується за швидкістю кірки) */
export interface FxSprite {
  key: string;
  x: number; y: number;
  size: number; grow: number; rot: number;
  life: number; max: number;
}

/* Скільки живе рядок у живому лозі й скільки їх тримати одночасно.
   Більше — і нижня смуга екрана перетворюється на суцільний текст. */
export const TOAST_LIFE = 1.6;
const TOAST_MAX = 3;

/* Стеля на частинки. Не краса, а захист кадру: на x25 із десятком
   вибухів поспіль їх набиралось стільки, що падав сам FPS. */
const PARTICLE_MAX = 900;

export class Effects {
  readonly particles: Particle[] = [];
  readonly popups: Popup[] = [];
  readonly toasts: Toast[] = [];
  readonly sprites: FxSprite[] = [];

  /** Вибух іскор у точці поля. power масштабує розліт. */
  burst(x: number, y: number, color: string, n: number, power = 1): void {
    if (this.particles.length > PARTICLE_MAX) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.6 + Math.random() * 3.2) * power;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5,
        size: 0.05 + Math.random() * 0.09,
        life: 0.4 + Math.random() * 0.6, color,
      });
    }
  }

  popup(p: Popup): void {
    this.popups.push(p);
  }

  /** Спалах картинкою. life — скільки живе, у секундах. */
  sprite(key: string, x: number, y: number, size: number, life: number, rot = 0, grow = 1.15): void {
    this.sprites.push({ key, x, y, size, grow, rot, life, max: life });
  }

  /** Рядок у живий лог унизу екрана («Уголь +12»). */
  log(text: string, color: string, money?: number): void {
    this.toasts.push({ text, color, life: TOAST_LIFE, money });
    if (this.toasts.length > TOAST_MAX) this.toasts.shift();
  }

  /* Крок часу. dt уже помножений на прискорення раунду — ефекти
     живуть у тому ж часі, що й усе інше на полі. */
  step(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += 22 * dt;          // тяжіння, у клітинках/с²
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.y -= 0.9 * dt;
      p.life -= dt;
      if (p.life <= 0) this.popups.splice(i, 1);
    }
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      this.toasts[i].life -= dt;
      if (this.toasts[i].life <= 0) this.toasts.splice(i, 1);
    }
    for (let i = this.sprites.length - 1; i >= 0; i--) {
      this.sprites[i].life -= dt;
      if (this.sprites[i].life <= 0) this.sprites.splice(i, 1);
    }
  }

  /** Нова шахта — іскри й числа з попередньої не тягнемо. */
  clearField(): void {
    this.particles.length = 0;
    this.popups.length = 0;
    this.sprites.length = 0;
  }

  /* Новий раунд гравця: гасне й живий лог. Декоративна шахта під
     рулеткою його НЕ гасить — там нема про що писати, а стерти чужі
     рядки вона б устигла. */
  clearAll(): void {
    this.clearField();
    this.toasts.length = 0;
  }
}
