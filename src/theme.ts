import { useEffect, useState } from "react";
import { useRepo } from "./store/repo";

const query = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme actually in effect, resolving "system" against the OS setting. */
export function useResolvedTheme(): "light" | "dark" {
  const theme = useRepo((s) => s.theme);
  const [systemDark, setSystemDark] = useState(query.matches);

  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}
