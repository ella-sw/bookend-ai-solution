import { ESSAY_RULES } from "@/lib/api/types";
import type { NewEssayParams } from "@/lib/newEssayParams";

// Free text stays out of URLs. An empty stored string explicitly clears a suggestion.
const PREFIX = "essayDirection:";
const memory = new Map<string, string>();
type Context = Pick<NewEssayParams, "f" | "s">;
const keyFor = ({ f, s }: Context) => f ? `${PREFIX}${f}:${s ?? ""}` : null;

export const normalizeEssayDirection = (value: string | null | undefined): string | null => value?.trim() || null;

export function readEssayDirection(params: Context, fallback: string | null = null): string | null {
  const key = keyFor(params);
  if (key) {
    let value = memory.get(key);
    if (value === undefined) {
      try { value = window.sessionStorage.getItem(key) ?? undefined; } catch { /* memory only */ }
    }
    if (value !== undefined) return normalizeEssayDirection(value);
  }
  return normalizeEssayDirection(fallback);
}

export function writeEssayDirection(params: Context, value: string) {
  const key = keyFor(params);
  if (!key) return;
  const limited = Array.from(value).slice(0, ESSAY_RULES.directionMax).join("");
  memory.set(key, limited);
  try { window.sessionStorage.setItem(key, limited); } catch { /* memory only */ }
}

export function clearEssayDirections() {
  memory.clear();
  try {
    const keys = Object.keys(window.sessionStorage).filter((key) => key.startsWith(PREFIX));
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch { /* memory cleared */ }
}
