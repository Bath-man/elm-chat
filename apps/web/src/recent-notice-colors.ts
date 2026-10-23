export const noticePresetColors = ["#fff2a8", "#ffd1dc", "#cceaff", "#d5f5dc", "#dcd4ff", "#ffffff"];
const storageKey = "elm-chat:recent-notice-colors";

function customColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) && !noticePresetColors.includes(value.toLowerCase());
}

export function loadRecentNoticeColors(): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter(customColor).map(color => color.toLowerCase()))].slice(0, 6);
  } catch { return []; }
}

export function rememberNoticeColor(color: string): void {
  if (!customColor(color)) return;
  const normalized = color.toLowerCase();
  const recent = [normalized, ...loadRecentNoticeColors().filter(item => item !== normalized)].slice(0, 6);
  try { sessionStorage.setItem(storageKey, JSON.stringify(recent)); }
  catch { /* Temporary color history must never block sending. */ }
}
