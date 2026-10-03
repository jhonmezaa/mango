import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

/** Pan and zoom of the canvas: the tree is drawn at `translate(x, y) scale(k)`. */
export interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

/**
 * Pan and zoom of the organization chart (design other-views.jsx `OrgChart`): drag, wheel or
 * pinch, double click, arrow keys, `+`, `-` and `0`. `layoutKey` changes when the tree changes
 * size (data loaded, branches folded), which fits it to the canvas again.
 */
export function useViewport(layoutKey: unknown) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  // After the user pans or zooms, a resize keeps their position instead of fitting again.
  const userMoved = useRef(false);
  const lastWidth = useRef(0);

  const fitView = useCallback(() => {
    const wrap = wrapRef.current;
    const tree = treeRef.current;
    if (!wrap || !tree) return;
    userMoved.current = false;
    lastWidth.current = wrap.clientWidth;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    const tw = Math.max(tree.offsetWidth, tree.scrollWidth);
    const th = Math.max(tree.offsetHeight, tree.scrollHeight);
    const k = Math.max(0.5, Math.floor(Math.min(1, (cw - 64) / tw, (ch - 64) / th) * 10) / 10);
    setView({
      k,
      x: tw * k > cw - 32 ? 32 : (cw - tw * k) / 2,
      y: Math.max(32, (ch - th * k) / 2),
    });
  }, []);

  useLayoutEffect(() => {
    fitView();
  }, [fitView, layoutKey]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    lastWidth.current = wrap.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = wrap.clientWidth;
      const delta = width - lastWidth.current;
      lastWidth.current = width;
      if (!delta) return;
      if (!userMoved.current) fitView();
      else setView((v) => ({ ...v, x: v.x + delta / 2 }));
    });
    observer.observe(wrap);
    return () => {
      observer.disconnect();
    };
  }, [fitView]);

  /** Zooms in steps of 10 % around a point of the canvas (its center by default). */
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number, step?: number) => {
    userMoved.current = true;
    setView((v) => {
      const pct = Math.round((v.k * 100) / 10) * 10;
      const raw = step === undefined ? Math.round((v.k * factor * 100) / 10) * 10 : pct + step;
      const next = raw === pct && step === undefined ? pct + (factor > 1 ? 10 : -10) : raw;
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next / 100));
      if (k === v.k) return v;
      const wrap = wrapRef.current;
      const px = cx ?? (wrap ? wrap.clientWidth / 2 : 0);
      const py = cy ?? (wrap ? wrap.clientHeight / 2 : 0);
      return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
    });
  }, []);

  const zoomBy = useCallback(
    (step: number) => {
      zoomAt(1, undefined, undefined, step);
    },
    [zoomAt],
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      if (event.ctrlKey || event.metaKey) {
        // Pinch on a trackpad.
        zoomAt(Math.exp(-event.deltaY * 0.01), cx, cy);
      } else if (
        event.deltaMode !== 0 ||
        (Math.abs(event.deltaX) < 1 && Math.abs(event.deltaY) >= 40)
      ) {
        // Mouse wheel.
        zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, cx, cy);
      } else {
        userMoved.current = true;
        setView((v) => ({
          ...v,
          x: v.x - (event.shiftKey ? event.deltaY : event.deltaX),
          y: v.y - (event.shiftKey ? 0 : event.deltaY),
        }));
      }
    };
    // Not passive: the canvas takes the wheel instead of scrolling the page.
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      wrap.removeEventListener('wheel', onWheel);
    };
  }, [zoomAt]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    drag.current = { sx: event.clientX, sy: event.clientY, x: view.x, y: view.y };
    userMoved.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const x = start.x + event.clientX - start.sx;
    const y = start.y + event.clientY - start.sy;
    setView((v) => ({ ...v, x, y }));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Browser shortcuts (⌘+, ⌘−, ⌘0: page zoom) stay with the browser.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 160 : 60;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      userMoved.current = true;
      setView((v) => ({ ...v, x: v.x + move[0], y: v.y + move[1] }));
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(10);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomBy(-10);
    } else if (event.key === '0') {
      event.preventDefault();
      fitView();
    }
  };
  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(1.4, event.clientX - rect.left, event.clientY - rect.top);
  };

  /** Moves the view just enough to show the first node that matches `selector`. */
  const reveal = useCallback((selector: string) => {
    const node = treeRef.current?.querySelector(selector);
    const wrap = wrapRef.current;
    if (!node || !wrap) return;
    const nr = node.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const pad = 24;
    let dx = 0;
    let dy = 0;
    if (nr.left < wr.left + pad) dx = wr.left + pad - nr.left;
    else if (nr.right > wr.right - pad) dx = wr.right - pad - nr.right;
    if (nr.top < wr.top + pad) dy = wr.top + pad - nr.top;
    else if (nr.bottom > wr.bottom - pad) dy = wr.bottom - pad - nr.bottom;
    if (dx || dy) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }, []);

  /** Centers the view on the first node that matches `selector`. */
  const center = useCallback((selector: string) => {
    const node = treeRef.current?.querySelector(selector);
    const wrap = wrapRef.current;
    if (!node || !wrap) return;
    const nr = node.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    userMoved.current = true;
    setView((v) => ({
      ...v,
      x: v.x + (wr.left + wr.width / 2) - (nr.left + nr.width / 2),
      y: v.y + (wr.top + wr.height / 2) - (nr.top + nr.height / 2),
    }));
  }, []);

  return {
    wrapRef,
    treeRef,
    view,
    dragging,
    fitView,
    zoomBy,
    reveal,
    center,
    canvasHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      onDoubleClick,
    },
  };
}
