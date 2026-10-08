import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

interface PointerState {
  pressed: boolean;
  dragging: boolean;
  dx: number;
  dy: number;
}

export function PointerIndicatorWindow() {
  const [state, setState] = useState<PointerState>({
    pressed: false,
    dragging: false,
    dx: 0,
    dy: 0,
  });

  useEffect(() => {
    document.documentElement.classList.add("pointer-root");
    return () => document.documentElement.classList.remove("pointer-root");
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<PointerState>("pointer-state", (event) => {
      setState(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const trailX = `${Math.round(-state.dx * 2.2)}px`;
  const trailY = `${Math.round(-state.dy * 2.2)}px`;

  return (
    <div
      className={`pointer-indicator ${state.pressed ? "pointer-pressed" : ""} ${
        state.dragging ? "pointer-dragging" : ""
      }`}
      style={{ "--trail-x": trailX, "--trail-y": trailY } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="pointer-trail pointer-trail-3" />
      <span className="pointer-trail pointer-trail-2" />
      <span className="pointer-trail pointer-trail-1" />
      <span className="pointer-core" />
    </div>
  );
}
