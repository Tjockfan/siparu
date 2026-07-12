/**
 * Theme: two modes on one axis - "night" (default, dark grays + red accent)
 * and "day" (light). Applied as <html data-theme="...">; token values live in
 * styles/swiss.css. Choice persists per device in localStorage.
 *
 * Night is the default on purpose: this screen lives on a bridge, and red
 * light preserves night vision.
 */

export type ThemeName = 'night' | 'day'

export const DEFAULT_THEME: ThemeName = 'night'

const KEY = 'sp_theme'

function isKnown(t: string | null): t is ThemeName {
  return t === 'night' || t === 'day'
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}

export function getTheme(): ThemeName {
  const v = localStorage.getItem(KEY)
  return isKnown(v) ? v : DEFAULT_THEME
}

export function saveTheme(theme: ThemeName): void {
  localStorage.setItem(KEY, theme)
  applyTheme(theme)
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = getTheme() === 'night' ? 'day' : 'night'
  saveTheme(next)
  return next
}

/** Apply the saved theme immediately on boot to avoid a flash. */
export function applyInitialTheme(): void {
  applyTheme(getTheme())
}
