import { MutationError } from "../protocol.ts";

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Moves `current` towards `target` by at most `rate * dt`. */
export function ramp(
  current: number,
  target: number,
  rate: number,
  dt: number,
): number {
  const step = rate * dt;
  if (Math.abs(target - current) <= step) return target;
  return current + Math.sign(target - current) * step;
}

/** First-order lag: approaches `target` with time constant `tau` seconds. */
export function lag(
  current: number,
  target: number,
  tau: number,
  dt: number,
): number {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** Gaussian noise (Box–Muller). */
export function noise(sigma: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Slowly wandering noise source (Ornstein–Uhlenbeck). */
export class Drift {
  value = 0;
  sigma: number;
  tau: number;
  constructor(sigma: number, tau: number) {
    this.sigma = sigma;
    this.tau = tau;
  }
  step(dt: number): number {
    this.value +=
      (-this.value / this.tau) * dt +
      this.sigma * Math.sqrt((2 * dt) / this.tau) * noise(1);
    return this.value;
  }
}

export function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new MutationError(
      `${name}: expected a number, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

export function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") {
    throw new MutationError(
      `${name}: expected a boolean, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

export function oneOf<T extends string>(
  v: unknown,
  options: readonly T[],
  name: string,
): T {
  if (typeof v !== "string" || !options.includes(v as T)) {
    throw new MutationError(
      `${name}: expected one of ${options.join("|")}, got ${JSON.stringify(v)}`,
    );
  }
  return v as T;
}

export const round = (v: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
