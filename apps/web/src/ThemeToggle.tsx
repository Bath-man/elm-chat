import { useState } from "react";
import { applyTheme, THEME_STORAGE_KEY, type Theme } from "./theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* The switch still works without persistence. */ }
  }
  return <button type="button" className="secondary-button theme-toggle" aria-label="夜间模式" aria-pressed={theme === "dark"} onClick={toggle}>
    {theme === "dark" ? "日间" : "夜间"}
  </button>;
}
