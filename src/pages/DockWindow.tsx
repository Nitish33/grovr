import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Link,
  LoaderCircle,
  MousePointer2,
  Plus,
  RefreshCw,
  Ruler,
  Zap,
  ScrollText,
  Settings,
  Square,
  SunMoon,
  Trash2,
  Video,
  type LucideIcon,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppTheme } from "@/hooks/useAppTheme";
import * as api from "@/lib/api";
import { formatSize } from "@/lib/format";
import type { DeepLink, DevicePlatform } from "@/lib/api";

const FEEDBACK_MS = 1600;
const DOCK_COLLAPSED_SIZE = { width: 48, height: 324 };
const DOCK_EXPANDED_SIZE = { width: 360, height: DOCK_COLLAPSED_SIZE.height };
const DESIGN_COLORS = [
  { name: "Green", value: "#4ade80" },
  { name: "Blue", value: "#60a5fa" },
  { name: "Pink", value: "#f472b6" },
  { name: "Yellow", value: "#facc15" },
];

interface DockAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => Promise<string | null>;
  /** The action reports its own progress (toasts, button state), so skip the generic feedback */
  selfReporting?: boolean;
}

type RecordingState = "idle" | "starting" | "recording" | "processing";

type DeepLinkDraft = {
  package: string;
  name: string;
  url: string;
};

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const platform: DevicePlatform =
    params.get("platform") === "android" ? "android" : "ios";
  return {
    platform,
    deviceId: params.get("id") ?? "",
    name: params.get("name") ?? "",
  };
}

/** The quick actions bar shown beside a simulator/emulator window (positioned by the backend). */
export function DockWindow() {
  useAppTheme();
  const { platform, deviceId, name } = useMemo(readParams, []);
  const [feedback, setFeedback] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recording, setRecording] = useState<RecordingState>("idle");
  const [linksOpen, setLinksOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const [alignmentActive, setAlignmentActive] = useState(false);
  const alignmentActiveRef = useRef(false);
  const [colorPicking, setColorPicking] = useState(false);
  const [designColor, setDesignColor] = useState(DESIGN_COLORS[0].value);
  const [pointerActive, setPointerActive] = useState(false);
  const [deepLinks, setDeepLinks] = useState<DeepLink[]>([]);
  const [apps, setApps] = useState<string[]>([]);
  const [draft, setDraft] = useState<DeepLinkDraft>({
    package: "",
    name: "",
    url: "",
  });
  const [packagePickerOpen, setPackagePickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(
    new Set(),
  );

  // The window is transparent so the bar can have rounded corners
  useEffect(() => {
    document.documentElement.classList.add("dock-root");
    return () => document.documentElement.classList.remove("dock-root");
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    const expanded = linksOpen || designOpen;
    getCurrentWindow()
      .setSize(
        new LogicalSize(
          expanded ? DOCK_EXPANDED_SIZE.width : DOCK_COLLAPSED_SIZE.width,
          expanded ? DOCK_EXPANDED_SIZE.height : DOCK_COLLAPSED_SIZE.height,
        ),
      )
      .catch((err) => console.error("Failed to resize quick bar:", err));
  }, [linksOpen, designOpen]);

  useEffect(
    () => () => {
      void api.hideDesignOverlay(platform, deviceId);
    },
    [platform, deviceId],
  );

  useEffect(() => {
    alignmentActiveRef.current = alignmentActive;
  }, [alignmentActive]);

  useEffect(() => {
    let unlistenPicked: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;
    listen<string>("design-color-picked", async (event) => {
      setColorPicking(false);
      setDesignColor(event.payload);
      if (alignmentActiveRef.current) {
        await api.showDesignOverlay(platform, deviceId, event.payload);
      } else {
        await api.hideDesignOverlay(platform, deviceId);
      }
    }).then((cleanup) => {
      unlistenPicked = cleanup;
    }).catch((err) => console.error("Failed to listen for picked design color:", err));
    listen("design-color-pick-cancelled", async () => {
      setColorPicking(false);
      if (!alignmentActiveRef.current) {
        await api.hideDesignOverlay(platform, deviceId);
      }
    }).then((cleanup) => {
      unlistenCancelled = cleanup;
    }).catch((err) => console.error("Failed to listen for design color cancellation:", err));
    return () => {
      unlistenPicked?.();
      unlistenCancelled?.();
    };
  }, [platform, deviceId]);

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        setDeepLinks((settings.deep_links ?? []).map((link) => ({ ...link, platform: link.platform ?? "ios" })));
      })
      .catch((err) => console.error("Failed to load deep links:", err));
  }, []);

  useEffect(() => {
    if (!linksOpen) return;
    api
      .listUserApps(platform, deviceId)
      .then((list) => {
        setApps(list);
        setDraft((current) => ({
          ...current,
          package: current.package || list[0] || name,
        }));
      })
      .catch((err) => {
        console.error("Failed to load apps:", err);
        setDraft((current) => ({
          ...current,
          package: current.package || name,
        }));
      });
  }, [linksOpen, platform, deviceId, name]);

  // The bar may have been closed and reopened while a recording was running
  useEffect(() => {
    api
      .deviceRecordingStartedAt(platform, deviceId)
      .then((startedAt) => {
        if (startedAt === null) return;
        setRecording("recording");
        void api.showRecordingIndicator(startedAt);
      })
      .catch(() => undefined);
  }, [platform, deviceId]);

  const toast = (message: string, kind: api.ToastKind = "ok", sticky = false) =>
    api
      .showDeviceToast(message, kind, sticky)
      .catch((err) => console.error("Failed to show the toast:", err));

  const closeDesignPanel = async () => {
    setDesignOpen(false);
    setAlignmentActive(false);
    setColorPicking(false);
    await api.hideDesignOverlay(platform, deviceId);
  };

  const toggleLinksPanel = async () => {
    if (!linksOpen) await closeDesignPanel();
    setLinksOpen((open) => !open);
  };

  const toggleDesignPanel = async () => {
    if (designOpen) {
      await closeDesignPanel();
      return;
    }
    setLinksOpen(false);
    setPackagePickerOpen(false);
    setAddOpen(false);
    setDesignOpen(true);
  };

  const toggleAlignment = async () => {
    if (alignmentActive) {
      setAlignmentActive(false);
      await api.hideDesignOverlay(platform, deviceId);
      return;
    }
    setAlignmentActive(true);
    await api.showDesignOverlay(platform, deviceId, designColor);
  };

  const chooseDesignColor = async (color: string) => {
    setDesignColor(color);
    if (alignmentActive) {
      await api.showDesignOverlay(platform, deviceId, color);
    }
  };

  const startColorPicker = async () => {
    setColorPicking(true);
    await api.showDesignOverlay(platform, deviceId, designColor, true, true);
  };

  const copyDesignColor = async () => {
    try {
      await writeText(designColor);
      await toast(`Copied ${designColor}`);
    } catch (err) {
      await toast(String(err), "error");
    }
  };

  const saveDeepLinks = async (next: DeepLink[]) => {
    setDeepLinks(next);
    await api.setDeepLinks(next);
  };

  const addDeepLink = async () => {
    const pkg = draft.package.trim();
    const linkName = draft.name.trim();
    const url = draft.url.trim();
    if (!pkg || !url) {
      await toast("Package/app and link are required", "error");
      return;
    }
    const next = [
      ...deepLinks,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        platform,
        package: pkg,
        name: linkName || url,
        url,
      },
    ];
    try {
      await saveDeepLinks(next);
      setDraft({ package: pkg, name: "", url: "" });
      await toast("Deep link saved");
    } catch (err) {
      await toast(String(err), "error");
    }
  };

  const removeDeepLink = async (id: string) => {
    try {
      await saveDeepLinks(deepLinks.filter((link) => link.id !== id));
    } catch (err) {
      await toast(String(err), "error");
    }
  };

  const openDeepLink = async (link: DeepLink) => {
    try {
      await api.deviceQuickAction(platform, deviceId, "open_url", link.url);
      window.localStorage.setItem(`grovr-last-deep-link-${platform}`, link.id);
      await toast(`Opened ${link.name}`);
    } catch (err) {
      await toast(String(err), "error");
    }
  };

  const openLastDeepLink = async () => {
    const lastId = window.localStorage.getItem(`grovr-last-deep-link-${platform}`);
    const link = visibleDeepLinks.find((item) => item.id === lastId) ?? visibleDeepLinks[0];
    if (!link) {
      throw new Error("No deep link saved");
    }
    await api.deviceQuickAction(platform, deviceId, "open_url", link.url);
    window.localStorage.setItem(`grovr-last-deep-link-${platform}`, link.id);
    return `Opened ${link.name}`;
  };

  const packageOptions = useMemo(
    () => [
      ...new Set(
        [
          draft.package,
          ...apps,
          ...deepLinks.filter((link) => link.platform === platform).map((link) => link.package),
        ].filter(Boolean),
      ),
    ],
    [apps, deepLinks, draft.package, platform],
  );

  const visibleDeepLinks = useMemo(
    () => deepLinks.filter((link) => link.platform === platform),
    [deepLinks, platform],
  );

  const groupedDeepLinks = useMemo(() => {
    const groups = new Map<string, DeepLink[]>();
    for (const link of visibleDeepLinks) {
      const list = groups.get(link.package) ?? [];
      list.push(link);
      groups.set(link.package, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleDeepLinks]);

  const togglePackage = (pkg: string) => {
    setExpandedPackages((current) => {
      const next = new Set(current);
      if (next.has(pkg)) next.delete(pkg);
      else next.add(pkg);
      return next;
    });
  };

  const toggleRecording = async (): Promise<null> => {
    if (recording === "starting" || recording === "processing") return null;

    if (recording === "idle") {
      // Show something right away: the recorder takes a moment to come up
      setRecording("starting");
      try {
        const startedAt = await api.startDeviceRecording(platform, deviceId);
        setRecording("recording");
        void api.showRecordingIndicator(startedAt);
        void toast("Recording started. Click again to stop");
      } catch (err) {
        setRecording("idle");
        void toast(String(err), "error");
      }
      return null;
    }

    // Stopping flushes the video to disk (and copies it off the emulator), which takes a moment
    setRecording("processing");
    void api.hideRecordingIndicator();
    void toast("Processing video…", "busy", true);
    try {
      const video = await api.stopDeviceRecording(platform, deviceId);
      await writeText(video.path);
      void toast(
        video.final_bytes < video.original_bytes
          ? `Video path copied (${formatSize(video.original_bytes)} → ${formatSize(video.final_bytes)})`
          : `Video path copied to the clipboard (${formatSize(video.final_bytes)})`,
      );
    } catch (err) {
      void toast(String(err), "error");
    } finally {
      setRecording("idle");
    }
    return null;
  };

  const actions: DockAction[] = [
    {
      id: "logs",
      label: "Stream logs",
      icon: ScrollText,
      run: async () => {
        await api.openLogWindow(platform, deviceId, name);
        return null;
      },
    },
    {
      id: "screenshot",
      label: "Copy a screenshot to the clipboard",
      icon: Camera,
      run: async () => {
        await api.deviceQuickAction(platform, deviceId, "screenshot");
        return "Screenshot copied to the clipboard";
      },
    },
    {
      id: "record",
      label: recording === "recording" ? "Stop recording" : "Record the screen",
      icon: Video,
      run: toggleRecording,
      selfReporting: true,
    },
    {
      id: "appearance",
      label: "Toggle dark mode",
      icon: SunMoon,
      run: async () => {
        const mode = await api.deviceQuickAction(
          platform,
          deviceId,
          "toggle_appearance",
        );
        return mode ? `Switched to ${mode} mode` : null;
      },
    },
    {
      id: "pointer-location",
      label: platform === "ios" ? "Show touch indicators" : "Show taps and pointer trace",
      icon: MousePointer2,
      run: async () => {
        const mode = await api.deviceQuickAction(platform, deviceId, "toggle_pointer_location");
        if (mode === "on") setPointerActive(true);
        if (mode === "off") setPointerActive(false);
        return mode ? `Touch indicators ${mode}` : null;
      },
    },
    {
      id: "open-url",
      label: "Deep links",
      icon: Link,
      run: async () => {
        await toggleLinksPanel();
        return null;
      },
      selfReporting: true,
    },
    {
      id: "open-last-url",
      label: "Open last deep link",
      icon: Zap,
      run: openLastDeepLink,
    },
    {
      id: "design",
      label: "Design tools",
      icon: Ruler,
      run: async () => {
        await toggleDesignPanel();
        return null;
      },
      selfReporting: true,
    },
    {
      id: "relaunch-app",
      label: "Relaunch current app",
      icon: RefreshCw,
      run: async () => {
        const appName = await api.deviceQuickAction(platform, deviceId, "relaunch_app");
        return appName ? `Relaunched ${appName}` : "Relaunched app";
      },
    },
    {
      id: "settings",
      label: "Quick bar settings",
      icon: Settings,
      run: async () => {
        await api.openQuickBarSettings();
        return null;
      },
      selfReporting: true,
    },
  ];

  const handleClick = async (action: DockAction) => {
    if (action.selfReporting) {
      await action.run();
      return;
    }
    let result: { ok: boolean; message: string };
    let toast = true;
    try {
      const message = await action.run();
      // Some actions (opening the log window) have nothing worth announcing
      toast = message !== null;
      result = { ok: true, message: message ?? action.label };
    } catch (err) {
      result = { ok: false, message: String(err) };
    }
    if (toast) {
      api
        .showDeviceToast(result.message, result.ok ? "ok" : "error")
        .catch((err) => console.error("Failed to show the toast:", err));
    }
    setFeedback({ id: action.id, ...result });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  };

  return (
    <div className="dock-shell">
      <div
        className="dock-bar"
        role="toolbar"
        aria-label={`Quick actions for ${name}`}
        aria-orientation="vertical"
      >
        {actions.map((action) => {
          const active = feedback?.id === action.id;
          const isRecord = action.id === "record";
          const isEnabled =
            (action.id === "open-url" && linksOpen) ||
            (action.id === "design" && designOpen) ||
            (action.id === "pointer-location" && pointerActive);
          const recordBusy =
            isRecord &&
            (recording === "starting" || recording === "processing");
          const Icon = active
            ? feedback.ok
              ? Check
              : AlertCircle
            : isRecord && recording === "recording"
              ? Square
              : recordBusy
                ? LoaderCircle
                : action.icon;
          const stateClass = active
            ? feedback.ok
              ? "dock-button-ok"
              : "dock-button-error"
            : isRecord && recording === "recording"
              ? "dock-button-recording"
              : isEnabled
                ? "dock-button-active"
                : "";
          return (
            <button
              key={action.id}
              className={`dock-button ${stateClass} ${action.id === "settings" ? "dock-button-settings" : ""}`}
              disabled={recordBusy}
              title={active ? feedback.message : action.label}
              aria-label={action.label}
              onClick={() => void handleClick(action)}
            >
              <Icon size={16} className={recordBusy ? "animate-spin" : ""} />
            </button>
          );
        })}
      </div>

      {linksOpen && (
        <div className="dock-deeplink-panel" aria-label="Deep links">
          <div className="dock-deeplink-list">
            {visibleDeepLinks.length === 0 && (
              <div className="dock-deeplink-empty">No {platform === "ios" ? "simulator" : "emulator"} deep links saved.</div>
            )}
            {groupedDeepLinks.map(([pkg, links]) => (
              <section key={pkg} className="dock-deeplink-group">
                <button
                  className="dock-deeplink-group-head"
                  onClick={() => togglePackage(pkg)}
                  aria-expanded={expandedPackages.has(pkg)}
                >
                  <span className="dock-deeplink-group-title">
                    {expandedPackages.has(pkg) ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                    <span>{pkg}</span>
                  </span>
                  <span>{links.length}</span>
                </button>
                {expandedPackages.has(pkg) && (
                  <div className="dock-deeplink-group-items">
                    {links.map((link) => (
                      <div
                        key={link.id}
                        className="dock-deeplink-row"
                        title={link.url}
                      >
                        <button
                          className="dock-deeplink-open"
                          onClick={() => void openDeepLink(link)}
                        >
                          <span className="dock-deeplink-name">
                            {link.name}
                          </span>
                          <span className="dock-deeplink-url">{link.url}</span>
                        </button>
                        <button
                          className="dock-deeplink-icon"
                          title={`Open ${link.name}`}
                          onClick={() => void openDeepLink(link)}
                        >
                          <ExternalLink size={12} />
                        </button>
                        <button
                          className="dock-deeplink-icon"
                          title={`Delete ${link.name}`}
                          onClick={() => void removeDeepLink(link.id)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>

          {!addOpen && (
            <div className="dock-deeplink-actions">
              <button
                className="dock-deeplink-add"
                onClick={() => setAddOpen(true)}
                title="Add deep link"
              >
                <Plus size={13} />
                <span>New deep link</span>
              </button>
            </div>
          )}

          {addOpen && (
            <div
              className="dock-deeplink-form-backdrop"
              onClick={() => setAddOpen(false)}
            />
          )}

          {addOpen && (
            <div className="dock-deeplink-form">
              <div className="dock-deeplink-form-head">
                <span>New deep link</span>
                <button onClick={() => setAddOpen(false)}>Cancel</button>
              </div>
              <div className="dock-deeplink-combo">
                <button
                  className="dock-deeplink-combo-button"
                  onClick={() => setPackagePickerOpen((open) => !open)}
                  aria-label="Package or app"
                  aria-expanded={packagePickerOpen}
                >
                  <span>{draft.package || "Package / app"}</span>
                  <ChevronDown size={13} />
                </button>
                {packagePickerOpen && (
                  <div className="dock-deeplink-combo-menu">
                    {packageOptions.length === 0 && (
                      <div className="dock-deeplink-combo-empty">
                        No apps found
                      </div>
                    )}
                    {packageOptions.map((app) => (
                      <button
                        key={app}
                        className={`dock-deeplink-combo-option ${draft.package === app ? "dock-deeplink-combo-option-active" : ""}`}
                        onClick={() => {
                          setDraft((current) => ({ ...current, package: app }));
                          setPackagePickerOpen(false);
                        }}
                      >
                        {app}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <input
                className="dock-deeplink-input"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Name"
                aria-label="Deep link name"
              />
              <input
                className="dock-deeplink-input"
                value={draft.url}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    url: event.target.value,
                  }))
                }
                placeholder="Link"
                aria-label="Deep link URL"
              />
              <button
                className="dock-deeplink-add"
                onClick={() => void addDeepLink()}
                title="Add deep link"
              >
                <Plus size={13} />
                <span>Add deep link</span>
              </button>
            </div>
          )}
        </div>
      )}

      {designOpen && (
        <div className="dock-design-panel" aria-label="Design tools">
          <div className={`dock-design-row ${alignmentActive ? "dock-design-row-active" : ""}`}>
            <button
              className="dock-design-toggle"
              onClick={() => void toggleAlignment()}
              aria-pressed={alignmentActive}
            >
              <span>Alignment</span>
              {alignmentActive && <Check size={13} />}
            </button>
            <div className="dock-design-colors" aria-label="Alignment guide color">
              {DESIGN_COLORS.map((color) => (
                <button
                  key={color.value}
                  className={`dock-design-color ${designColor === color.value ? "dock-design-color-active" : ""}`}
                  style={{ background: color.value }}
                  title={color.name}
                  aria-label={color.name}
                  onClick={() => void chooseDesignColor(color.value)}
                />
              ))}
            </div>
          </div>
          <div className={`dock-design-row ${colorPicking ? "dock-design-row-active" : ""}`}>
            <button
              className="dock-design-toggle"
              onClick={() => void startColorPicker()}
              aria-pressed={colorPicking}
            >
              <span>Color picker</span>
            </button>
            <button
              className="dock-design-hex"
              onClick={() => void copyDesignColor()}
              title={`Copy ${designColor}`}
              aria-label={`Copy ${designColor}`}
            >
              <span style={{ background: designColor }} />
              <code>{designColor}</code>
            </button>
          </div>
          <div className="dock-design-shortcut">
            <span>Shift</span>
            <span>Show spacing</span>
          </div>
        </div>
      )}
    </div>
  );
}
