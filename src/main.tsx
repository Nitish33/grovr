import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DockWindow } from "./pages/DockWindow";
import { LogsWindow } from "./pages/LogsWindow";
import { JsonViewerWindow } from "./pages/JsonViewerWindow";
import "./index.css";

// The JSON viewer, device logs and device quick bar open in their own windows, loading
// this same bundle with ?view=json|logs|dock
const view = new URLSearchParams(window.location.search).get("view");

function Root() {
  switch (view) {
    case "json":
      return <JsonViewerWindow />;
    case "logs":
      return <LogsWindow />;
    case "dock":
      return <DockWindow />;
    default:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
