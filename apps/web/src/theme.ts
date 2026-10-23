export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "elm-chat:theme";

export function getInitialTheme(saved: string | null, systemDark: boolean): Theme {
  return saved === "light" || saved === "dark" ? saved : systemDark ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#121212" : "#ffffff");
}

export function initializeTheme(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  applyTheme(getInitialTheme(saved, window.matchMedia("(prefers-color-scheme: dark)").matches));
}
