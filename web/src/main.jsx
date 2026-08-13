import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles/base.scss";
import "./styles/avatar_canvas.scss";
import "./styles/full_view.scss";
import "./styles/transcript.scss";
import "./styles/text_full_view.scss";
import "./styles/mascot.scss";

// Desktop mascot overlay (#mascot): the Electron window is transparent, so
// the page must be too. Tag the root before first paint — the CSS override
// (mascot.scss) keys off this class. Exact-match: #mascot-settings is a
// normal framed window and must keep its opaque background.
if (/^#mascot(-resume)?$/.test(window.location.hash)) {
    document.documentElement.classList.add("rx_mascot_mode");
}

createRoot(document.getElementById("root")).render(<App />);
