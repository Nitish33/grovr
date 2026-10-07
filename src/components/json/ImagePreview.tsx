import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const SHOW_DELAY_MS = 150;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 288;
const GAP = 8;

interface PreviewState {
  url: string;
  anchor: DOMRect;
}

interface ImagePreviewApi {
  show: (url: string, anchor: DOMRect) => void;
  hide: () => void;
}

const ImagePreviewContext = createContext<ImagePreviewApi | null>(null);

export function useImagePreview(): ImagePreviewApi {
  const api = useContext(ImagePreviewContext);
  if (!api) throw new Error('useImagePreview must be used inside <ImagePreviewProvider>');
  return api;
}

function PreviewCard({ url, anchor }: PreviewState) {
  const [failed, setFailed] = useState(false);

  // Prefer below the link; flip above when there isn't room. Keep inside the window.
  const openAbove = anchor.bottom + GAP + PREVIEW_HEIGHT > window.innerHeight && anchor.top > PREVIEW_HEIGHT;
  const left = Math.max(GAP, Math.min(anchor.left, window.innerWidth - PREVIEW_WIDTH - GAP));
  const position = openAbove
    ? { left, bottom: window.innerHeight - anchor.top + GAP }
    : { left, top: anchor.bottom + GAP };

  return (
    <div className="image-preview" style={position} role="tooltip">
      {failed ? (
        <div className="image-preview-error">Couldn&apos;t load image</div>
      ) : (
        <img src={url} alt="Image link preview" className="image-preview-img" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

/** Shows a floating image preview while an image link is hovered. */
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const show = useCallback((url: string, anchor: DOMRect) => {
    clearTimer();
    timer.current = setTimeout(() => setPreview({ url, anchor }), SHOW_DELAY_MS);
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setPreview(null);
  }, []);

  useEffect(() => clearTimer, []);

  const api = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <ImagePreviewContext.Provider value={api}>
      {children}
      {preview && <PreviewCard key={preview.url} {...preview} />}
    </ImagePreviewContext.Provider>
  );
}
