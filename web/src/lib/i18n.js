// Translation shim. The ported services call _t("...", ...subs) with %s
// placeholders (Odoo convention) — substitute sequentially, no translation.
export function _t(str, ...subs) {
  let i = 0;
  return String(str).replace(/%s/g, () => (i < subs.length ? String(subs[i++]) : "%s"));
}
