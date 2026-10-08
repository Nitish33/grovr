import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DockWindow } from "./pages/DockWindow";
import { DesignOverlayWindow } from "./pages/DesignOverlayWindow";
import { LogsWindow } from "./pages/LogsWindow";
import { PointerIndicatorWindow } from "./pages/PointerIndicatorWindow";
import { QuickBarSettingsWindow } from "./pages/QuickBarSettingsWindow";
import { RecordingIndicatorWindow } from "./pages/RecordingIndicatorWindow";
import { ToastWindow } from "./pages/ToastWindow";
import { JsonViewerWindow } from "./pages/JsonViewerWindow";
import "./index.css";

// The JSON viewer, device logs and device quick bar (and its toasts) open in their own windows, loading
// this same bundle with ?view=json|logs|dock|toast|recording|quickbar-settings
const view = new URLSearchParams(window.location.search).get("view");

if (view === "design-overlay") {
  document.documentElement.classList.add("design-overlay-root");
}

function Root() {
  switch (view) {
    case "json":
      return <JsonViewerWindow />;
    case "logs":
      return <LogsWindow />;
    case "dock":
      return <DockWindow />;
    case "design-overlay":
      return <DesignOverlayWindow />;
    case "toast":
      return <ToastWindow />;
    case "recording":
      return <RecordingIndicatorWindow />;
    case "pointer":
      return <PointerIndicatorWindow />;
    case "quickbar-settings":
      return <QuickBarSettingsWindow />;
    default:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
