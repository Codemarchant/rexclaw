// Minimal deep-reactive store, API-compatible with the `reactive()` the ported
// services were written against (OWL's). Mutations anywhere in the object
// graph notify subscribers; React components subscribe via useReactive() and
// re-render on any change (coarse-grained — fine at this app's scale).
import { useSyncExternalStore } from "react";

const SUBS = new WeakMap();   // root target → Set<fn>
const VERSION = new WeakMap(); // root target → integer
const PROXIES = new WeakMap(); // raw object → proxy (per root, see makeHandler)

function notify(root) {
  VERSION.set(root, (VERSION.get(root) || 0) + 1);
  const subs = SUBS.get(root);
  if (subs) {
    for (const fn of [...subs]) {
      try { fn(); } catch (e) { /* subscriber errors never break a write */ }
    }
  }
}

function makeHandler(root) {
  return {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value && typeof value === "object" && !(value instanceof Date)
          && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
        let cache = PROXIES.get(value);
        if (!cache) { cache = new Map(); PROXIES.set(value, cache); }
        let proxy = cache.get(root);
        if (!proxy) {
          proxy = new Proxy(value, makeHandler(root));
          cache.set(root, proxy);
        }
        return proxy;
      }
      return value;
    },
    set(target, prop, value, receiver) {
      const prev = Reflect.get(target, prop, receiver);
      const ok = Reflect.set(target, prop, value, receiver);
      if (ok && prev !== value) notify(root);
      return ok;
    },
    deleteProperty(target, prop) {
      const ok = Reflect.deleteProperty(target, prop);
      if (ok) notify(root);
      return ok;
    },
  };
}

const ROOT_OF = new WeakMap(); // proxy → root target

export function reactive(obj) {
  const proxy = new Proxy(obj, makeHandler(obj));
  SUBS.set(obj, new Set());
  VERSION.set(obj, 0);
  ROOT_OF.set(proxy, obj);
  return proxy;
}

export function subscribe(reactiveObj, fn) {
  const root = ROOT_OF.get(reactiveObj);
  if (!root) return () => {};
  SUBS.get(root).add(fn);
  return () => SUBS.get(root)?.delete(fn);
}

/** React hook: re-render this component whenever `reactiveObj` mutates. */
export function useReactive(reactiveObj) {
  const root = ROOT_OF.get(reactiveObj);
  useSyncExternalStore(
    (onChange) => subscribe(reactiveObj, onChange),
    () => (root ? VERSION.get(root) : 0),
  );
  return reactiveObj;
}
