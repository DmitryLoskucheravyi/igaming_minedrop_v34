/* ============================================================
   RNG — детермінований генератор + SHA-256/HMAC без залежностей.

   Чому свій SHA-256, а не node:crypto: цей самий код має однаково
   працювати і на сервері, і в браузері (клієнт переграє раунд у себе
   й перевіряє, що виплата зійшлася). node:crypto в браузері немає,
   а WebCrypto асинхронний — тому тут синхронна реалізація на ~90 рядків.

   ГОЛОВНЕ ПРАВИЛО ДЕТЕРМІНІЗМУ
   Один сид -> один і той самий раунд, байт у байт, у node і в браузері.
   Тому:
     - жодного Math.random() в рушії;
     - у кожного споживача випадковості СВІЙ потік (mine / phys / reel),
       інакше зайвий виклик в одному ламає всі інші;
     - шахта сіється ПОРЯДКОВО (rowRng(r)), а не спільним потоком —
       клієнт малює ряди наперед, і якби вони бралися з послідовного
       потоку, порядок генерації розійшовся б із серверним.
   ============================================================ */

export type Rng = () => number;

/* ---------------- SHA-256 ---------------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(msg: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  // довжина в бітах — 64-бітне BE-число в останніх 8 байтах
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > 64) k = sha256(k);
  const pad = new Uint8Array(64);
  pad.set(k);

  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = pad[i] ^ 0x36;
    outer[i] = pad[i] ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/* ---------------- hex / utf8 ---------------- */

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export const sha256Hex = (s: string) => toHex(sha256(utf8(s)));

/* ---------------- генератори ---------------- */

/* splitmix32 — розгін одного 32-бітного числа в потік. Використовується
   тільки щоб посіяти sfc32 і щоб зробити порядковий сид шахти. */
function splitmix32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
}

/* sfc32 — робочий генератор. Швидкий, з періодом ~2^128,
   на цілочисельній арифметиці, тому однаковий скрізь. */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  a |= 0; b |= 0; c |= 0; d |= 0;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function rngFromSeedNumber(seed: number): Rng {
  const s = splitmix32(seed);
  const r = sfc32(s() * 4294967296, s() * 4294967296, s() * 4294967296, s() * 4294967296);
  for (let i = 0; i < 12; i++) r();      // прогрів
  return r;
}

/* Окремий іменований потік від сида раунду.
   stream(seed, 'phys') і stream(seed, 'reel') незалежні — зайвий виклик
   в одному не зсуває інший. */
export function stream(seedHex: string, label: string): Rng {
  const d = hmacSha256(fromHex(seedHex), utf8(label));
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const r = sfc32(dv.getUint32(0), dv.getUint32(4), dv.getUint32(8), dv.getUint32(12));
  for (let i = 0; i < 12; i++) r();
  return r;
}

/* 32-бітний корінь для порядкового сидування шахти */
export function streamRoot(seedHex: string, label: string): number {
  const d = hmacSha256(fromHex(seedHex), utf8(label));
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0) | 0;
}

/* Генератор конкретного ряду шахти. Залежить ТІЛЬКИ від (root, row),
   тому не важливо, в якому порядку ряди попросили. */
export function rowRng(root: number, row: number): Rng {
  return rngFromSeedNumber((root ^ Math.imul(row + 0x9e3779b9, 0x85ebca6b)) | 0);
}

/* ---------------- зважений вибір ---------------- */

/* Поріг саме `< 0`, а не `<= 0`.

   rnd() віддає число з [0, 1), тому x = rnd() * total ∈ [0, total) —
   і при x рівно 0 (sfc32 це вміє) умова `x <= 0` спрацьовувала на
   ПЕРШОМУ ж елементі, навіть якщо його вага 0. У depthWeights перший
   ключ — `air: 0`, тобто в суцільній шахті раз на ~4 млрд клітинок
   з'являлась порожня. З `< 0` елемент із нульовою вагою недосяжний
   за побудовою: `x -= 0` не рухає x, а якби x уже був < 0, ми б
   вийшли раніше. Кінцевий fallback лишається лише як страховка від
   total === 0. */
export function pickWeighted<T extends { weight: number }>(arr: readonly T[], rnd: Rng): T {
  let total = 0;
  for (const it of arr) total += it.weight;
  let x = rnd() * total;
  for (const it of arr) { x -= it.weight; if (x < 0) return it; }
  return arr[arr.length - 1];
}

export function pickWeightedKey(weights: Record<string, number>, rnd: Rng, fallback: string): string {
  let total = 0;
  for (const k in weights) total += weights[k];
  let x = rnd() * total;
  for (const k in weights) { x -= weights[k]; if (x < 0) return k; }
  return fallback;
}
