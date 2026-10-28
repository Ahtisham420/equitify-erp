/**
 * Small helpers that reproduce Python numeric semantics the underwriting engine relies on, so that the financial
 * math stays numerically identical to the Python implementation:
 *  - `round()` (half-to-even on the exact binary value), `int(round(x))`
 *  - `sum()` of floats (Python 3.12 uses Neumaier compensated summation)
 *  - `float(x)` parsing, truthiness, `==` on JSON values
 *  - `random.Random(seed)` (Mersenne Twister) with `random()`, `uniform()`, `triangular()`
 *  - `float ** n` raising on overflow / division by zero (OverflowError / ZeroDivisionError)
 */

export type Obj = Record<string, any>;

export const isDict = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);

/** Python list-or-empty for `x or []` loops whose items are then type-checked. */
export const asList = (x: unknown): any[] => (Array.isArray(x) ? x : []);

/** Python truthiness of a JSON value. */
export function truthy(x: unknown): boolean {
  if (x === null || x === undefined || x === false || x === 0 || x === "") return false;
  if (typeof x === "number" && Number.isNaN(x)) return true;
  if (Array.isArray(x)) return x.length > 0;
  if (isDict(x)) return Object.keys(x).length > 0;
  return true;
}

export class PyError extends Error {}

// --------------------------------------------------------------------------- float parsing

const FLOAT_RE = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;

/** Python `float(x)`; `undefined` when Python would raise (TypeError / ValueError). Bools are not handled here. */
export function pyFloat(x: unknown): number | undefined {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "string") {
    const s = x.trim();
    const m = /^([+-]?)(inf|infinity|nan)$/i.exec(s);
    if (m) return m[2].toLowerCase() === "nan" ? NaN : m[1] === "-" ? -Infinity : Infinity;
    if (FLOAT_RE.test(s)) return Number(s.replace(/_/g, ""));
  }
  return undefined;
}

/** Python `float(x)` that raises. */
export function toFloat(x: unknown): number {
  const f = pyFloat(x);
  if (f === undefined) throw new PyError(`could not convert ${JSON.stringify(x)} to float`);
  return f;
}

// --------------------------------------------------------------------------- rounding

function decompose(x: number): { m: bigint; e: number } {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  return exp === 0 ? { m: frac, e: -1074 } : { m: frac | (1n << 52n), e: exp - 1075 };
}

/** Python `round(x)` -> int (half to even). */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return Math.round(x);
}

/** Python `round(x, nd)`: correctly rounded decimal of the exact binary value, ties to even. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  if (nd === 0) return roundHalfEven(x);
  const { m, e } = decompose(Math.abs(x));
  // exact tie <=> |x| * 10^nd * 2 is an odd integer
  if (e < 0) {
    const num = m * 10n ** BigInt(nd) * 2n;
    const k = BigInt(-e);
    if (num % (1n << k) === 0n) {
      const v = num >> k;
      if (v % 2n === 1n) {
        const q = (v - 1n) / 2n;
        const even = q % 2n === 0n ? q : q + 1n;
        const r = Number(`${even}e-${nd}`);
        return x < 0 ? -r : r;
      }
    }
  }
  return Number(x.toFixed(nd));
}

// --------------------------------------------------------------------------- sum()

/** Python 3.12 `sum()` of floats (Neumaier compensated summation). */
export function pySum(items: Iterable<number>): number {
  let f = 0;
  let c = 0;
  for (const x of items) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x;
    else c += x - t + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

// --------------------------------------------------------------------------- pow

/** Python `a ** b` for floats: raises on overflow, 0 ** negative and negative ** fractional (complex). */
export function pyPow(a: number, b: number): number {
  if (a === 0 && b < 0) throw new PyError("0.0 cannot be raised to a negative power");
  if (a < 0 && !Number.isInteger(b)) throw new PyError("negative number cannot be raised to a fractional power");
  const r = Math.pow(a, b);
  if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) throw new PyError("Numerical result out of range");
  return r;
}

// --------------------------------------------------------------------------- equality

/** Python `==` for JSON values. */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// --------------------------------------------------------------------------- dates (datetime.date)

export interface PyDate {
  year: number;
  month: number;
  day: number;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
export const isoDate = (d: PyDate) => `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
export const dateFromJs = (d: Date): PyDate => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
/** `date.today()` (UTC). */
export const today = (): PyDate => dateFromJs(new Date());
export const firstOfMonth = (d: PyDate): PyDate => ({ year: d.year, month: d.month, day: 1 });

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** `date.fromisoformat(s)` for `YYYY-MM-DD` / `YYYYMMDD`; `null` where Python raises ValueError. */
export function fromIso(s: string): PyDate | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m || (s.length === 10) !== s.includes("-")) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  return { year, month, day };
}

/** Parse a "YYYY-MM-DD" string (as stored in `date` columns, or a Date) into a PyDate. */
export function toPyDate(v: unknown): PyDate | null {
  if (v instanceof Date) return dateFromJs(v);
  if (typeof v === "string") return fromIso(v.slice(0, 10));
  return null;
}

// --------------------------------------------------------------------------- random.Random (MT19937)

const N = 624;
const M = 397;

export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: number) {
    let n = BigInt(Math.abs(Math.trunc(seed)));
    const key: number[] = [];
    if (n === 0n) key.push(0);
    while (n > 0n) {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    }
    this.initByArray(key);
  }

  private initGenrand(s: number) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]) {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private genrand(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      let y: number;
      for (; kk < N - M; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random(): number {
    const a = this.genrand() >>> 5;
    const b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  triangular(low: number, high: number, mode: number): number {
    let u = this.random();
    if (high - low === 0) return low; // ZeroDivisionError branch in CPython
    let c = (mode - low) / (high - low);
    if (u > c) {
      u = 1.0 - u;
      c = 1.0 - c;
      [low, high] = [high, low];
    }
    return low + (high - low) * Math.sqrt(u * c);
  }
}
