/** djb2 hash → unsigned 32-bit integer. Used as a deterministic per-student shuffle seed. */
export function djb2Hash(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0
  }
  return h
}

/** Fisher-Yates shuffle driven by an LCG seeded from `seed`. Returns a new array; input is not mutated. */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr]
  let s = seed >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
