// Toast store, shaped like Odoo's notification service (`add(message, {type,
// sticky})`). The Toasts component subscribes via useReactive.
import { reactive } from "./reactive";

let nextId = 1;

export const toastState = reactive({ items: [] });

export const notification = {
  add(message, { type = "info", sticky = false } = {}) {
    const id = nextId++;
    toastState.items = [...toastState.items, { id, message: String(message), type, sticky }];
    if (!sticky) {
      setTimeout(() => notification.remove(id), 6000);
    }
    return id;
  },
  remove(id) {
    toastState.items = toastState.items.filter((t) => t.id !== id);
  },
};
