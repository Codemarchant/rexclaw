import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";

const dollars = (n) => `$${n.toFixed(2)}`;

/** "3% of this week's allowance used · resets Sat 10 Oct, 12:15", plus
 *  extra usage credits and auto top-up when the account has them. */
function usageLine(u) {
    const percent = `${Number(u.percent.toFixed(1))}%`;
    const resets = u.resets_at ? new Date(u.resets_at).toLocaleString(undefined,
        { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    const parts = [u.period === "weekly" ? _t("%s of this week's allowance used", percent)
        : u.period === "monthly" ? _t("%s of this month's allowance used", percent)
        : _t("%s of the allowance used", percent)];
    if (resets) parts.push(_t("resets %s", resets));
    if (u.prepaid_usd > 0) parts.push(_t("%s extra usage credits", dollars(u.prepaid_usd)));
    if (u.on_demand_cap_usd > 0) parts.push(_t("auto top-up %s of %s", dollars(u.on_demand_used_usd), dollars(u.on_demand_cap_usd)));
    return parts.join(" · ");
}

/** Sign in with Grok (server/xai_oauth.py): a SuperGrok or X Premium
 *  subscription in place of the API key. Acts at once, outside the
 *  Save/Discard draft — like the user photo. `status` is config.xai_oauth;
 *  `onStatus` replaces it after a sign-in, sign-out or retry. */
export default function GrokSignIn({ status, hasApiKey, onStatus }) {
    const [code, setCode] = useState(null);   // {user_code, url} while waiting for approval
    const [busy, setBusy] = useState(false);
    const [usage, setUsage] = useState(null);   // the subscription's allowance, while signed in
    const [usageBusy, setUsageBusy] = useState(false);
    const [showAccount, setShowAccount] = useState(false);   // hidden by default, for demos and screenshots
    const timer = useRef(null);
    const stopPolling = () => { clearTimeout(timer.current); timer.current = null; };
    useEffect(() => stopPolling, []);
    useEffect(() => {
        setUsage(null);
        if (!status?.signed_in) return;
        let cancelled = false;
        rpc("/api/xai/oauth/usage", {})
            .then((res) => { if (!cancelled && !res.error) setUsage(res); })
            .catch(() => { /* the line just stays hidden */ });
        return () => { cancelled = true; };
    }, [status?.signed_in]);
    // xAI's billing endpoint is read live; the line only fetches when Settings opens.
    const refreshUsage = async () => {
        setUsageBusy(true);
        try {
            const res = await rpc("/api/xai/oauth/usage", {});
            if (res.error) notification.add(res.error, { type: "danger" });
            else setUsage(res);
        } catch (e) {
            notification.add(e?.message || _t("Something went wrong"), { type: "danger" });
        } finally {
            setUsageBusy(false);
        }
    };

    const poll = (interval) => {
        timer.current = setTimeout(async () => {
            let res;
            try {
                res = await rpc("/api/xai/oauth/poll", {});
            } catch (e) {
                res = { state: "pending", interval };
            }
            if (res.state === "pending") return poll(res.interval || interval);
            timer.current = null;
            setCode(null);
            if (res.state === "done") onStatus({ signed_in: true, account: res.account, refused: null, expired: null });
            else if (res.state === "error") notification.add(res.message, { type: "danger" });
        }, interval * 1000);
    };
    const start = async () => {
        setBusy(true);
        try {
            const res = await rpc("/api/xai/oauth/start", {});
            setCode(res);
            window.open(res.url, "_blank", "noopener");
            poll(res.interval);
        } catch (e) {
            notification.add(e?.message || _t("Could not start the sign-in"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };
    const cancel = () => {
        stopPolling();
        setCode(null);
        rpc("/api/xai/oauth/cancel", {}).catch(() => {});
    };
    const act = async (route, next) => {
        setBusy(true);
        try {
            await rpc(route, {});
            onStatus({ ...status, ...next });
        } catch (e) {
            notification.add(e?.message || _t("Something went wrong"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{ margin: "0.75rem 0" }}>
            <label>{_t("Grok subscription")}</label>
            <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                {_t("Use a SuperGrok or X Premium subscription instead of paying per use: calls come out "
                    + "of its weekly allowance, which Grok chat shares. xAI decides which accounts and "
                    + "features it covers. While signed in it replaces the API key. If the allowance "
                    + "runs out or xAI refuses the subscription, calls switch to the API key (billed "
                    + "per use) when one is saved, until you press Try again. Custom voices from the "
                    + "xAI console only work on the API key, so sign out here to use them.")}
            </p>
            {status?.signed_in ? (
                <>
                    <div>
                        <i className="fa fa-check" /> {status.account && showAccount
                            ? `${_t("Signed in as")} ${status.account}` : _t("Signed in")}
                        {status.account && (
                            <button className="btn btn-link btn-sm" onClick={() => setShowAccount(!showAccount)}
                                    title={showAccount ? _t("Hide account") : _t("Show account")}>
                                <i className={showAccount ? "fa fa-eye-slash" : "fa fa-eye"} />
                            </button>
                        )}
                        <button className="btn btn-light btn-sm" style={{ marginLeft: "0.5rem" }} disabled={busy}
                                onClick={() => act("/api/xai/oauth/sign_out", { signed_in: false, account: "", refused: null })}>
                            {_t("Sign out")}
                        </button>
                    </div>
                    {usage && (
                        <p className="text-muted small" style={{ margin: "0.25rem 0 0" }}>
                            {usageLine(usage)}
                            <button className="btn btn-link btn-sm" onClick={refreshUsage} disabled={usageBusy}
                                    title={_t("Refresh usage")}>
                                <i className={usageBusy ? "fa fa-refresh fa-spin" : "fa fa-refresh"} />
                            </button>
                        </p>
                    )}
                    {status.refused && (
                        <p className="small text-danger" style={{ margin: "0.25rem 0 0" }}>
                            {status.refused}{" "}
                            {hasApiKey ? _t("Using your API key until you try again.")
                                : _t("Save an API key above to keep working until then.")}{" "}
                            <button className="btn btn-link btn-sm" disabled={busy}
                                    onClick={() => act("/api/xai/oauth/retry", { refused: null })}>
                                {_t("Try again")}
                            </button>
                        </p>
                    )}
                </>
            ) : code ? (
                <p className="small" style={{ margin: 0 }}>
                    {_t("Approve the sign-in in your browser. If it asks for a code, enter")}{" "}
                    <code style={{ fontSize: "1.1em" }}>{code.user_code}</code>{" "}
                    <span className="text-muted"><i className="fa fa-spinner fa-spin" /> {_t("Waiting for approval…")}</span>{" "}
                    <a href={code.url} target="_blank" rel="noreferrer">{_t("Open the page again")}</a>{" "}
                    <button className="btn btn-link btn-sm" onClick={cancel}>{_t("Cancel")}</button>
                </p>
            ) : (
                <div>
                    <button className="btn btn-light" onClick={start} disabled={busy}>
                        <i className={busy ? "fa fa-spinner fa-spin" : "fa fa-sign-in"} /> {_t("Sign in with Grok")}
                    </button>
                    {status?.expired && <p className="small text-danger" style={{ margin: "0.25rem 0 0" }}>{status.expired}</p>}
                </div>
            )}
        </div>
    );
}
