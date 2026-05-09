export type ThemePref = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'theme'

export function readThemePref(): ThemePref {
  if (typeof localStorage === 'undefined') return 'system'
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function writeThemePref(pref: ThemePref): void {
  if (typeof localStorage === 'undefined') return
  if (pref === 'system') localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, pref)
}

export function resolveDark(pref: ThemePref): boolean {
  if (pref === 'dark') return true
  if (pref === 'light') return false
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', resolveDark(pref))
}

// Inline script that runs before paint to set the .dark class on <html>.
// Also exposes window.__pvApplyTheme so the toggle can re-run it.
export const themeBootstrapScript = `(function(){function r(){try{var p=localStorage.getItem('theme');var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}}r();try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',r);}catch(e){}window.__pvApplyTheme=r;})();`
