import { _t } from "../lib/i18n";
import React from "react";
import { toastState, notification } from "../lib/notification";
import { useReactive } from "../lib/reactive";

export default function Toasts() {
    const state = useReactive(toastState);
    if (!state.items.length) return null;
    return (
        <div className="rx_toasts">
            {state.items.map((t) => (
                <div key={t.id} className={`rx_toast rx_toast--${t.type}`}>
                    <span>{t.message}</span>
                    <button onClick={() => notification.remove(t.id)} title={_t("Dismiss")}>
                        <i className="fa fa-times" />
                    </button>
                </div>
            ))}
        </div>
    );
}
