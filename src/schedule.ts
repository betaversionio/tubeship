// Spreading a batch over time: the first video at `start`, then one every
// `every` (e.g. "1d", "12h", "90m"). Videos that already have a publishAt keep it.

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "1d" -> 86 400 000. Accepts m, h, d, w. */
export function parseInterval(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(s.trim());
  if (!m) throw new Error(`interval "${s}": use a number and m, h, d or w, e.g. "1d" or "12h"`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

/**
 * publishAt for each item (ISO strings), or the item's own value when it has
 * one. Items with their own time don't use up a slot.
 */
export function scheduleTimes(items: readonly { publishAt?: string | undefined }[], start: string, every: string): string[] {
  const t0 = Date.parse(start);
  if (Number.isNaN(t0)) throw new Error(`schedule start "${start}" isn't a valid time (e.g. 2026-10-05T18:00:00+05:30)`);
  const step = parseInterval(every);
  let slot = 0;
  return items.map((it) => it.publishAt ?? new Date(t0 + step * slot++).toISOString());
}
