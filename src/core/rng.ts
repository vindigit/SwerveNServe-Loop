/**
 * Deterministic RNG (mulberry32). Jobs, spawns and any other run-owned
 * randomness draw from a seeded stream so a bug can be reproduced by replaying
 * the seed. Math.random() must not appear in gameplay code.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** 0..1 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, max). */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  reseed(seed: number): void {
    this.state = seed >>> 0 || 1;
  }
}
