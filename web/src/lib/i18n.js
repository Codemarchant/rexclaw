// UI translation layer. The ported services call _t("...", ...subs) with %s
// placeholders (Odoo convention); components wrap their visible strings the
// same way. Keys are the English source strings — a missing key just renders
// the English, so an incomplete dictionary degrades gracefully.
//
// The active locale lives in a reactive store: App subscribes to it via
// useReactive, so flipping the language re-renders the whole mounted tree in
// place (no remount — a live voice session survives the switch). The choice
// persists per-browser in localStorage and defaults to the browser language.
import { reactive } from "./reactive";
import { JA } from "./locales/ja";

const STORAGE_KEY = "rexclaw.locale";

export const LOCALES = [
  ["en", "English"],
  ["ja", "日本語"],
];

const DICTS = { ja: JA };

function detectLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES.some(([id]) => id === stored)) return stored;
  } catch (e) { /* private mode */ }
  const nav = (navigator.language || "en").toLowerCase();
  return nav.startsWith("ja") ? "ja" : "en";
}

export const i18nState = reactive({ locale: detectLocale() });

export function setLocale(locale) {
  if (!LOCALES.some(([id]) => id === locale)) return;
  i18nState.locale = locale;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch (e) { /* private mode */ }
}

export function _t(str, ...subs) {
  const dict = DICTS[i18nState.locale];
  const translated = (dict && dict[str]) || str;
  let i = 0;
  return String(translated).replace(/%s/g, () => (i < subs.length ? String(subs[i++]) : "%s"));
}
