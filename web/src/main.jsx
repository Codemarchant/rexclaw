import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import CaptionsWindowView from "./components/CaptionsWindowView.jsx";
import "./styles/base.scss";
import "./styles/avatar_canvas.scss";
import "./styles/full_view.scss";
import "./styles/transcript.scss";
import "./styles/text_full_view.scss";
import "./styles/share_popover.scss";
import "./styles/mascot.scss";
import "./styles/toys.scss";
import "./styles/memory_galaxy.scss";
import "./styles/stage.scss";
import "./styles/manga.scss";
import "./styles/captions.scss";

// Desktop mascot overlay (#mascot): the Electron window is transparent, so
// the page must be too. Tag the root before first paint — the CSS override
// (mascot.scss) keys off this class. Exact-match: #mascot-settings is a
// normal framed window and must keep its opaque background.
if (/^#mascot(-resume)?$/.test(window.location.hash)) {
    document.documentElement.classList.add("rx_mascot_mode");
}

// Desktop captions window (#captions): transparent like the mascot, and a
// bare caption display — not an App instance, so none of the per-window
// services (wake word, heartbeat polling, hotkeys) ever start in it.
const CAPTIONS_MODE = /^#captions/.test(window.location.hash);
if (CAPTIONS_MODE) document.documentElement.classList.add("rx_mascot_mode");

createRoot(document.getElementById("root")).render(CAPTIONS_MODE ? <CaptionsWindowView /> : <App />);
