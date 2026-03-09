import { rmSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath, sep as pathSep } from "node:path";

function normalizeAbsolutePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const resolved = resolvePath(trimmed);
  return isAbsolute(resolved) ? resolved : null;
}

export function cleanupSlidesPayload(raw: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  const slidesDir = normalizeAbsolutePath((payload as { slidesDir?: unknown }).slidesDir);
  const slides = Array.isArray((payload as { slides?: unknown }).slides)
    ? ((payload as { slides?: unknown }).slides as Array<{ imagePath?: unknown }>)
    : [];
  if (!slidesDir) return;
  const dirPrefix = slidesDir.endsWith(pathSep) ? slidesDir : `${slidesDir}${pathSep}`;
  const safeRemove = (target: string) => {
    try {
      rmSync(target, { force: true });
    } catch {
      // ignore
    }
  };
  for (const slide of slides) {
    const imagePath = normalizeAbsolutePath(slide?.imagePath);
    if (!imagePath) continue;
    if (!imagePath.startsWith(dirPrefix)) continue;
    safeRemove(imagePath);
  }
  safeRemove(join(slidesDir, "slides.json"));
}
