/** Small persisted UI preferences. Storage can be unavailable; never throw. */
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`grove.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref<T>(key: string, value: T) {
  try {
    localStorage.setItem(`grove.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}
