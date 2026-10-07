import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { JsonViewerWindow } from "./pages/JsonViewerWindow";
import "./index.css";

// The JSON viewer opens in its own window, loading this same bundle with ?view=json
const isJsonViewer = new URLSearchParams(window.location.search).get("view") === "json";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isJsonViewer ? <JsonViewerWindow /> : <App />}
  </React.StrictMode>,
);
