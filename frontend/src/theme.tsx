import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark";
const KEY = "routewise.theme";
const systemTheme = (): Theme =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

// index.html applies a saved choice before first paint; this keeps React in sync and follows
// the system setting until the user picks one.
export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  return set === "dark" || set === "light" ? set : systemTheme();
}
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(currentTheme());
    media?.addEventListener("change", onChange);
    window.addEventListener("routewise-theme", onChange);
    return () => {
      media?.removeEventListener("change", onChange);
      window.removeEventListener("routewise-theme", onChange);
    };
  }, []);
  return theme;
}
export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  window.dispatchEvent(new Event("routewise-theme"));
}

export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="theme-toggle"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
