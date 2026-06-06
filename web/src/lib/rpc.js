// JSON POST helper, shaped like the Odoo rpc() the ported services call:
// resolves with the parsed body, rejects with an Error whose .message (and
// .data.message, for the ported `e?.data?.message` reads) carries the
// server's UserError text.
export async function rpc(path, params = {}) {
  let resp;
  try {
    resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params ?? {}),
    });
  } catch (e) {
    const err = new Error(e?.message || "Network error");
    err.data = { message: err.message };
    throw err;
  }
  let body = null;
  try {
    body = await resp.json();
  } catch (e) {
    body = null;
  }
  if (!resp.ok) {
    const message = body?.error?.message || body?.error || body?.detail || `Request failed (${resp.status})`;
    const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
    err.data = { message: err.message };
    err.status = resp.status;
    throw err;
  }
  return body;
}
