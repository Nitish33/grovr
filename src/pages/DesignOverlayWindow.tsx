import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { Trash2 } from "lucide-react";
import * as api from "@/lib/api";
import type { DevicePlatform } from "@/lib/api";

type Guide = {
  id: number;
  orientation: "vertical" | "horizontal";
  position: number;
};

type PickTarget = {
  platform: DevicePlatform;
  deviceId: string;
  pickOnly?: boolean;
};

type OverlayTarget = {
  platform: DevicePlatform;
  deviceId: string;
};

const RULER = 24;

function readColor() {
  return new URLSearchParams(window.location.search).get("color") || "#4ade80";
}

function readOverlayTarget(): OverlayTarget | null {
  const params = new URLSearchParams(window.location.search);
  const platform = params.get("platform") === "android" ? "android" : params.get("platform") === "ios" ? "ios" : null;
  const deviceId = params.get("id");
  return platform && deviceId ? { platform, deviceId } : null;
}

function readInitialPickTarget(): PickTarget | null {
  const params = new URLSearchParams(window.location.search);
  const platform = params.get("platform") === "android" ? "android" : params.get("platform") === "ios" ? "ios" : null;
  const deviceId = params.get("id");
  return params.get("pick") === "1" && platform && deviceId
    ? { platform, deviceId, pickOnly: params.get("pickOnly") === "1" }
    : null;
}

function designGuidesStorageKey(target: OverlayTarget) {
  return `grovr-design-guides-${target.platform}-${target.deviceId}`;
}

function loadGuides(target: OverlayTarget | null, width: number, height: number): Guide[] {
  if (!target) return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(designGuidesStorageKey(target)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item, index) => {
      if (
        !item ||
        typeof item !== "object" ||
        !("orientation" in item) ||
        !("position" in item) ||
        (item.orientation !== "vertical" && item.orientation !== "horizontal") ||
        typeof item.position !== "number"
      ) {
        return [];
      }
      const max = item.orientation === "vertical" ? width : height;
      return [{
        id: index + 1,
        orientation: item.orientation,
        position: Math.max(0, Math.min(max, item.position * max)),
      }];
    });
  } catch {
    return [];
  }
}

export function DesignOverlayWindow() {
  const overlayTarget = useMemo(readOverlayTarget, []);
  const [color, setColor] = useState(readColor);
  const [guides, setGuides] = useState<Guide[]>(() => loadGuides(overlayTarget, window.innerWidth, window.innerHeight));
  const [selected, setSelected] = useState<number | null>(null);
  const [shiftDown, setShiftDown] = useState(false);
  const [pickTarget, setPickTarget] = useState<PickTarget | null>(readInitialPickTarget);
  const [preview, setPreview] = useState<(api.DesignColorPreview & { x: number; y: number }) | null>(null);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const dragRef = useRef<{ id: number; orientation: Guide["orientation"] } | null>(null);
  const idRef = useRef(1);
  const previewRef = useRef({ at: 0, seq: 0 });
  const nativeIgnoresCursor = useRef<boolean | null>(null);
  const selectedGuide = guides.find((guide) => guide.id === selected);

  useEffect(() => {
    document.documentElement.classList.add("design-overlay-root");
    return () => document.documentElement.classList.remove("design-overlay-root");
  }, []);

  useEffect(() => {
    idRef.current = Math.max(0, ...guides.map((guide) => guide.id)) + 1;
  }, []);

  useEffect(() => {
    if (!overlayTarget) return;
    try {
      localStorage.setItem(
        designGuidesStorageKey(overlayTarget),
        JSON.stringify(guides.map((guide) => ({
          orientation: guide.orientation,
          position: guide.position / Math.max(1, guide.orientation === "vertical" ? size.width : size.height),
        }))),
      );
    } catch {
      // Ignore storage failures; the guide overlay should remain usable.
    }
  }, [guides, overlayTarget, size.height, size.width]);

  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("design-overlay-color", (event) => setColor(event.payload)).then((cleanup) => {
      unlisten = cleanup;
    }).catch((err) => console.error("Failed to listen for design color:", err));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<PickTarget>("design-start-color-pick", (event) => {
      setPickTarget(event.payload);
      setPreview(null);
    }).then((cleanup) => {
      unlisten = cleanup;
    }).catch((err) => console.error("Failed to listen for design color picker:", err));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const max = drag.orientation === "vertical" ? size.width : size.height;
      const next = Math.max(0, Math.min(max, drag.orientation === "vertical" ? event.clientX : event.clientY));
      setGuides((items) => items.map((item) => item.id === drag.id ? { ...item, position: next } : item));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [size.width, size.height]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;

    const setNativePassthrough = async (ignore: boolean) => {
      if (nativeIgnoresCursor.current === ignore) return;
      nativeIgnoresCursor.current = ignore;
      try {
        await appWindow.setIgnoreCursorEvents(ignore);
      } catch (err) {
        console.error("Failed to update design overlay cursor passthrough:", err);
      }
    };

    const isOverDeleteButton = (x: number, y: number) => {
      if (!selectedGuide) return false;
      const left = selectedGuide.orientation === "vertical" ? Math.min(size.width - 36, selectedGuide.position + 8) : RULER + 8;
      const top = selectedGuide.orientation === "horizontal" ? Math.min(size.height - 36, selectedGuide.position + 8) : RULER + 8;
      return x >= left && x <= left + 32 && y >= top && y <= top + 32;
    };

    const isInteractivePoint = (x: number, y: number) => {
      if (pickTarget || dragRef.current) return true;
      if (x < 0 || y < 0 || x > size.width || y > size.height) return false;
      if (x <= RULER || x >= size.width - RULER || y <= RULER || y >= size.height - RULER) return true;
      if (isOverDeleteButton(x, y)) return true;
      return guides.some((guide) =>
        guide.orientation === "vertical"
          ? Math.abs(x - guide.position) <= 6
          : Math.abs(y - guide.position) <= 6,
      );
    };

    const updatePassthrough = async () => {
      try {
        const [cursor, position, scaleFactor] = await Promise.all([
          cursorPosition(),
          appWindow.outerPosition(),
          appWindow.scaleFactor(),
        ]);
        if (cancelled) return;
        const x = (cursor.x - position.x) / scaleFactor;
        const y = (cursor.y - position.y) / scaleFactor;
        await setNativePassthrough(!isInteractivePoint(x, y));
      } catch (err) {
        console.error("Failed to hit-test design overlay:", err);
        await setNativePassthrough(false);
      }
    };

    void updatePassthrough();
    const interval = window.setInterval(updatePassthrough, 50);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      void setNativePassthrough(false);
    };
  }, [guides, pickTarget, selectedGuide, size.height, size.width]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      setShiftDown(event.shiftKey);
      if (event.key === "Escape" && pickTarget) {
        setPickTarget(null);
        setPreview(null);
        void emit("design-color-pick-cancelled");
        return;
      }
      if (selected !== null && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        const guide = guides.find((item) => item.id === selected);
        if (!guide) return;
        const delta =
          (guide.orientation === "vertical" && event.key === "ArrowLeft") ||
          (guide.orientation === "horizontal" && event.key === "ArrowUp")
            ? -1
            : (guide.orientation === "vertical" && event.key === "ArrowRight") ||
                (guide.orientation === "horizontal" && event.key === "ArrowDown")
              ? 1
              : 0;
        if (delta !== 0) {
          event.preventDefault();
          const max = guide.orientation === "vertical" ? size.width : size.height;
          setGuides((items) =>
            items.map((item) =>
              item.id === selected
                ? { ...item, position: Math.max(0, Math.min(max, item.position + delta)) }
                : item,
            ),
          );
        }
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selected !== null) {
        setGuides((items) => items.filter((item) => item.id !== selected));
        setSelected(null);
      }
    };
    const onUp = (event: KeyboardEvent) => setShiftDown(event.shiftKey);
    const onBlur = () => setShiftDown(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [guides, pickTarget, selected, size.height, size.width]);

  const ticks = useMemo(() => {
    const horizontal = Array.from({ length: Math.floor(size.width / 10) + 1 }, (_, index) => index * 10);
    const vertical = Array.from({ length: Math.floor(size.height / 10) + 1 }, (_, index) => index * 10);
    return { horizontal, vertical };
  }, [size]);

  const addGuide = (orientation: Guide["orientation"], position: number) => {
    const max = orientation === "vertical" ? size.width : size.height;
    const guide = {
      id: idRef.current++,
      orientation,
      position: Math.max(0, Math.min(max, position)),
    };
    setGuides((items) => [...items, guide]);
    setSelected(guide.id);
  };

  const deleteSelected = () => {
    if (selected === null) return;
    setGuides((items) => items.filter((item) => item.id !== selected));
    setSelected(null);
  };

  const verticalMeasures = useMemo(
    () => measures(
      guides.filter((guide) => guide.orientation === "vertical").map((guide) => guide.position),
      RULER,
      size.width - RULER,
    ),
    [guides, size.width],
  );
  const horizontalMeasures = useMemo(
    () => measures(
      guides.filter((guide) => guide.orientation === "horizontal").map((guide) => guide.position),
      RULER,
      size.height - RULER,
    ),
    [guides, size.height],
  );
  const showAlignmentTools = !(pickTarget?.pickOnly);

  const pickColor = async (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pickTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const target = pickTarget;
    try {
      const picked = await api.pickDesignColor(target.platform, target.deviceId, event.clientX, event.clientY);
      setColor(picked);
      setPickTarget(null);
      setPreview(null);
      await emit("design-color-picked", picked);
    } catch (err) {
      setPickTarget(null);
      setPreview(null);
      console.error("Failed to pick design color:", err);
      await emit("design-color-pick-cancelled");
    }
  };

  const updatePreview = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pickTarget) return;
    const now = performance.now();
    if (now - previewRef.current.at < 55) return;
    previewRef.current.at = now;
    const seq = previewRef.current.seq + 1;
    previewRef.current.seq = seq;
    const x = event.clientX;
    const y = event.clientY;
    api.previewDesignColor(pickTarget.platform, pickTarget.deviceId, x, y)
      .then((next) => {
        if (previewRef.current.seq === seq) {
          setPreview({ ...next, x, y });
        }
      })
      .catch(() => undefined);
  };

  return (
    <div
      className={`design-overlay ${pickTarget ? "design-overlay-picking" : ""}`}
      tabIndex={0}
      onPointerDownCapture={(event) => void pickColor(event)}
      onPointerMoveCapture={updatePreview}
    >
      {pickTarget && <div className="design-pick-hint">Click a pixel to pick color</div>}
      {pickTarget && preview && (
        <div
          className="design-pick-magnifier"
          style={{
            left: Math.min(size.width - 118, preview.x + 16),
            top: Math.min(size.height - 110, preview.y + 16),
          }}
        >
          <div
            className="design-pick-grid"
            style={{
              gridTemplateColumns: `repeat(${preview.width}, 1fr)`,
              gridTemplateRows: `repeat(${preview.height}, 1fr)`,
            }}
          >
            {preview.pixels.map((pixel, index) => (
              <span
                key={`${index}-${pixel}`}
                className={index === Math.floor(preview.height / 2) * preview.width + Math.floor(preview.width / 2) ? "design-pick-pixel-center" : ""}
                style={{ background: pixel }}
              />
            ))}
            <code className="design-pick-hex">{preview.center}</code>
          </div>
          <span className="design-pick-swatch" style={{ background: preview.center }} />
        </div>
      )}
      {showAlignmentTools && (
        <>
          <RulerStrip edge="top" ticks={ticks.horizontal} onAdd={(position) => addGuide("vertical", position)} />
          <RulerStrip edge="bottom" ticks={ticks.horizontal} onAdd={(position) => addGuide("vertical", position)} />
          <RulerStrip edge="left" ticks={ticks.vertical} onAdd={(position) => addGuide("horizontal", position)} />
          <RulerStrip edge="right" ticks={ticks.vertical} onAdd={(position) => addGuide("horizontal", position)} />
        </>
      )}

      {showAlignmentTools && guides.map((guide) => (
        <button
          key={guide.id}
          className={`design-guide design-guide-${guide.orientation}`}
          style={{
            background: color,
            left: guide.orientation === "vertical" ? guide.position - 2 : 0,
            top: guide.orientation === "horizontal" ? guide.position - 2 : 0,
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            setSelected(guide.id);
            dragRef.current = { id: guide.id, orientation: guide.orientation };
          }}
          title={`${Math.round(guide.position)} px`}
          aria-label={`${guide.orientation} guide at ${Math.round(guide.position)} pixels`}
        />
      ))}

      {showAlignmentTools && selectedGuide && (
        <button
          className="design-guide-delete"
          style={{
            left: selectedGuide.orientation === "vertical" ? Math.min(size.width - 36, selectedGuide.position + 8) : RULER + 8,
            top: selectedGuide.orientation === "horizontal" ? Math.min(size.height - 36, selectedGuide.position + 8) : RULER + 8,
          }}
          onClick={deleteSelected}
          title="Delete guide"
          aria-label="Delete guide"
        >
          <Trash2 size={14} />
        </button>
      )}

      {showAlignmentTools && shiftDown && verticalMeasures.map((item) => (
        <span
          key={`v-${item.start}-${item.end}`}
          className="design-measure design-measure-horizontal"
          style={{ left: item.mid, top: RULER + 12 }}
        >
          {item.distance}px
        </span>
      ))}
      {showAlignmentTools && shiftDown && horizontalMeasures.map((item) => (
        <span
          key={`h-${item.start}-${item.end}`}
          className="design-measure design-measure-vertical"
          style={{ left: RULER + 12, top: item.mid }}
        >
          {item.distance}px
        </span>
      ))}
    </div>
  );
}

function measures(positions: number[], frameStart: number, frameEnd: number) {
  const insideFrame = positions.filter((position) => position > frameStart && position < frameEnd);
  const sorted = [frameStart, ...insideFrame, frameEnd].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, index) => {
    const end = sorted[index + 1];
    return {
      start: Math.round(start),
      end: Math.round(end),
      mid: (start + end) / 2,
      distance: Math.round(end - start),
    };
  }).filter((item) => item.distance > 0);
}

function RulerStrip({
  edge,
  ticks,
  onAdd,
}: {
  edge: "top" | "bottom" | "left" | "right";
  ticks: number[];
  onAdd: (position: number) => void;
}) {
  const horizontal = edge === "top" || edge === "bottom";
  return (
    <div
      className={`design-ruler design-ruler-${edge}`}
      onClick={(event) => onAdd(horizontal ? event.clientX : event.clientY)}
    >
      {ticks.map((tick) => (
        <span
          key={tick}
          className={`design-ruler-tick ${tick % 50 === 0 ? "design-ruler-tick-major" : ""}`}
          style={horizontal ? { left: tick } : { top: tick }}
        >
          {tick % 100 === 0 && <span>{tick}</span>}
        </span>
      ))}
    </div>
  );
}
