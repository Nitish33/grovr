import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LogsWindow } from "./pages/LogsWindow";
import { JsonViewerWindow } from "./pages/JsonViewerWindow";
import "./index.css";

// The JSON viewer and device logs open in their own windows, loading this same bundle with ?view=json|logs
const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "json" ? <JsonViewerWindow /> : view === "logs" ? <LogsWindow /> : <App />}
  </React.StrictMode>,
);
