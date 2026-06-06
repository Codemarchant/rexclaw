import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles/base.scss";
import "./styles/avatar_canvas.scss";
import "./styles/full_view.scss";
import "./styles/transcript.scss";
import "./styles/text_full_view.scss";

createRoot(document.getElementById("root")).render(<App />);
