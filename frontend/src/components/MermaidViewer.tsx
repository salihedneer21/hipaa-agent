import { useEffect, useMemo, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { Bug, Maximize, RefreshCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { Diagram } from '../types';
import { apiFetch } from '../api';

declare global {
  interface Window {
    mermaid?: any;
  }
}

const MERMAID_CDN_SRCS = [
  'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js',
  'https://unpkg.com/mermaid@10/dist/mermaid.min.js',
];

let mermaidLoading: Promise<any> | null = null;

async function loadMermaid(): Promise<any> {
  if (typeof window === 'undefined') return null;
  if (window.mermaid) return window.mermaid;
  if (mermaidLoading) return mermaidLoading;

  const loadFrom = (src: string) =>
    new Promise<any>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-mermaid-loader="true"]');
      if (existing && !window.mermaid) {
        existing.remove();
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.mermaidLoader = 'true';
      script.onload = () => resolve(window.mermaid);
      script.onerror = () => {
        script.remove();
        reject(new Error(`Failed to load Mermaid (${src})`));
      };
      document.head.appendChild(script);
    });

  mermaidLoading = (async () => {
    let last: unknown = null;
    for (const src of MERMAID_CDN_SRCS) {
      try {
        const m = await loadFrom(src);
        if (m) return m;
        last = new Error(`Mermaid loaded but window.mermaid is empty (${src})`);
      } catch (e) {
        last = e;
      }
    }
    throw (last instanceof Error ? last : new Error('Failed to load Mermaid'));
  })()
    .catch((e) => {
      // Allow retry on later renders if network comes back.
      mermaidLoading = null;
      throw e;
    });

  return mermaidLoading;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isFixableMermaidError(error: string | null): boolean {
  if (!error) return false;
  // Avoid burning agent calls on loader/network failures.
  return !/failed to load mermaid|mermaid not available/i.test(error);
}

export function MermaidViewer({
  diagram,
  sessionId,
  onDiagramUpdated,
  autoFix = true,
}: {
  diagram: Diagram;
  sessionId: string | null;
  onDiagramUpdated: (diagram: Diagram) => void;
  autoFix?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgWrapRef = useRef<HTMLDivElement | null>(null);
  const isPanningRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [fixAttempts, setFixAttempts] = useState(0);
  const [isFixing, setIsFixing] = useState(false);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const AUTO_FIX_MAX_ATTEMPTS = 4;

  const canAttemptFix = Boolean(sessionId && isFixableMermaidError(renderError));
  const shouldAutoFix = autoFix && canAttemptFix && !isFixing && fixAttempts < AUTO_FIX_MAX_ATTEMPTS;
  const isAutoFixing = autoFix && canAttemptFix && isFixing && fixAttempts <= AUTO_FIX_MAX_ATTEMPTS;
  const showManualFix = canAttemptFix && (!autoFix || fixAttempts >= AUTO_FIX_MAX_ATTEMPTS);

  const transformStyle = useMemo(() => {
    return {
      transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
      transformOrigin: '0 0',
    } as const;
  }, [offset.x, offset.y, scale]);

  useEffect(() => {
    setFixAttempts(0);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [diagram.name]);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      setIsRendering(true);
      setRenderError(null);

      try {
        const mermaid = await loadMermaid();
        if (!mermaid) throw new Error('Mermaid not available');

        // Safe defaults
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
        });

        if (typeof mermaid.parse === 'function') {
          await mermaid.parse(diagram.mermaid);
        }

        const id = `mmd_${diagram.name}_${Date.now()}`;
        const out = await mermaid.render(id, diagram.mermaid);
        const svg = typeof out === 'string' ? out : out?.svg;
        const bindFunctions = typeof out === 'object' ? out?.bindFunctions : undefined;
        if (!svg) throw new Error('Mermaid render returned empty SVG');

        if (cancelled) return;
        if (!svgWrapRef.current) return;

        svgWrapRef.current.innerHTML = svg;
        const svgElement = svgWrapRef.current.querySelector('svg');
        if (svgElement) {
          svgElement.style.maxWidth = 'none';
          svgElement.style.maxHeight = 'none';
          svgElement.setAttribute('preserveAspectRatio', 'xMinYMin meet');
          // Prevent blur on zoom by using crisp rendering
          svgElement.style.shapeRendering = 'geometricPrecision';
        }
        if (typeof bindFunctions === 'function') {
          bindFunctions(svgWrapRef.current);
        }

        // Auto-fit the diagram to the view after render
        // Use double requestAnimationFrame to ensure DOM is fully updated
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!cancelled && containerRef.current && svgWrapRef.current) {
              const svg = svgWrapRef.current.querySelector('svg');
              if (svg) {
                const containerRect = containerRef.current.getBoundingClientRect();

                // Get the natural size of the SVG
                let svgWidth = 800;
                let svgHeight = 600;

                // Try getBBox first for most accurate dimensions
                try {
                  const bbox = svg.getBBox();
                  if (bbox.width > 0 && bbox.height > 0) {
                    svgWidth = bbox.width;
                    svgHeight = bbox.height;
                  }
                } catch {
                  // getBBox can fail if SVG is not rendered
                  if (svg.viewBox?.baseVal?.width && svg.viewBox?.baseVal?.height) {
                    svgWidth = svg.viewBox.baseVal.width;
                    svgHeight = svg.viewBox.baseVal.height;
                  } else {
                    const widthAttr = svg.getAttribute('width');
                    const heightAttr = svg.getAttribute('height');
                    if (widthAttr && heightAttr) {
                      svgWidth = parseFloat(widthAttr) || 800;
                      svgHeight = parseFloat(heightAttr) || 600;
                    }
                  }
                }

                if (svgWidth > 0 && svgHeight > 0 && containerRect.width > 0 && containerRect.height > 0) {
                  const padding = 40;
                  const availableWidth = containerRect.width - padding * 2;
                  const availableHeight = containerRect.height - padding * 2;
                  const scaleX = availableWidth / svgWidth;
                  const scaleY = availableHeight / svgHeight;
                  const fitScale = Math.min(scaleX, scaleY, 1.5);
                  const scaledWidth = svgWidth * fitScale;
                  const scaledHeight = svgHeight * fitScale;
                  const offsetX = (containerRect.width - scaledWidth) / 2;
                  const offsetY = (containerRect.height - scaledHeight) / 2;

                  setScale(clamp(fitScale, 0.25, 4));
                  setOffset({ x: offsetX, y: offsetY });
                }
              }
            }
          });
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to render diagram';
        setRenderError(message);
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    };

    render();
    return () => {
      cancelled = true;
    };
  }, [diagram.mermaid, diagram.name]);

  const fixDiagram = async () => {
    if (!sessionId) return;
    if (!renderError) return;
    if (!isFixableMermaidError(renderError)) return;
    if (isFixing) return;

    setFixAttempts(prev => prev + 1);
    setIsFixing(true);
    try {
      const response = await apiFetch(`/api/sessions/${sessionId}/diagrams/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: diagram.name, error: renderError }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fix diagram');
      onDiagramUpdated(data.diagram as Diagram);
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : 'Failed to fix diagram');
    } finally {
      setIsFixing(false);
    }
  };

  useEffect(() => {
    if (!autoFix) return;
    if (!renderError) return;
    if (!canAttemptFix) return;
    if (fixAttempts >= AUTO_FIX_MAX_ATTEMPTS) return;
    if (isFixing) return;

    const delay = 500 + fixAttempts * 900;
    const timer = setTimeout(() => {
      fixDiagram();
    }, delay);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AUTO_FIX_MAX_ATTEMPTS, autoFix, canAttemptFix, fixAttempts, isFixing, renderError, sessionId]);

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    isPanningRef.current = true;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
  };

  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isPanningRef.current) return;
    if (!lastPointRef.current) return;
    const dx = e.clientX - lastPointRef.current.x;
    const dy = e.clientY - lastPointRef.current.y;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
    setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  const stopPan = () => {
    isPanningRef.current = false;
    lastPointRef.current = null;
  };

  // Use native wheel event with passive: false to prevent browser zoom
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const direction = e.deltaY < 0 ? 1 : -1;
      const currentScale = scaleRef.current;
      const nextScale = clamp(currentScale * (direction > 0 ? 1.12 : 0.9), 0.25, 4);
      const ratio = nextScale / currentScale;

      setOffset(prev => ({
        x: cx - ratio * (cx - prev.x),
        y: cy - ratio * (cy - prev.y),
      }));
      setScale(nextScale);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const fitToView = useCallback(() => {
    const container = containerRef.current;
    const svgWrap = svgWrapRef.current;
    if (!container || !svgWrap) return;

    const svg = svgWrap.querySelector('svg');
    if (!svg) return;

    const containerRect = container.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return;

    // Get the natural size of the SVG - try getBBox first
    let svgWidth = 800;
    let svgHeight = 600;

    try {
      const bbox = svg.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        svgWidth = bbox.width;
        svgHeight = bbox.height;
      }
    } catch {
      if (svg.viewBox?.baseVal?.width && svg.viewBox?.baseVal?.height) {
        svgWidth = svg.viewBox.baseVal.width;
        svgHeight = svg.viewBox.baseVal.height;
      } else {
        const widthAttr = svg.getAttribute('width');
        const heightAttr = svg.getAttribute('height');
        if (widthAttr && heightAttr) {
          svgWidth = parseFloat(widthAttr) || 800;
          svgHeight = parseFloat(heightAttr) || 600;
        }
      }
    }

    if (svgWidth === 0 || svgHeight === 0) return;

    const padding = 40;
    const availableWidth = containerRect.width - padding * 2;
    const availableHeight = containerRect.height - padding * 2;

    const scaleX = availableWidth / svgWidth;
    const scaleY = availableHeight / svgHeight;
    const fitScale = Math.min(scaleX, scaleY, 1.5);

    const scaledWidth = svgWidth * fitScale;
    const scaledHeight = svgHeight * fitScale;
    const offsetX = (containerRect.width - scaledWidth) / 2;
    const offsetY = (containerRect.height - scaledHeight) / 2;

    setScale(clamp(fitScale, 0.25, 4));
    setOffset({ x: offsetX, y: offsetY });
  }, []);

  return (
    <div className="mermaid-viewer">
      <div className="mermaid-toolbar">
        <button className="btn btn-secondary btn-sm" onClick={() => setScale(s => clamp(s * 1.15, 0.25, 4))} title="Zoom in">
          <ZoomIn size={14} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setScale(s => clamp(s * 0.87, 0.25, 4))} title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={fitToView} title="Fit to view">
          <Maximize size={14} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} title="Reset to 100%">
          <RefreshCcw size={14} />
        </button>
        {isAutoFixing && (
          <div className="mermaid-fixing" title="Agent is attempting to auto-fix this diagram">
            <span className="spinner spinner-dark" />
            Auto-fixing…
          </div>
        )}
        {renderError && showManualFix && !isFixing && (
          <button className="btn btn-secondary btn-sm" onClick={fixDiagram} title="Ask agent to fix Mermaid">
            <Bug size={14} />
            Fix
          </button>
        )}
      </div>

      <div
        className="mermaid-canvas"
        ref={containerRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={stopPan}
        onMouseLeave={stopPan}
      >
        <div className="mermaid-svg-wrap" ref={svgWrapRef} style={transformStyle} />

        {isRendering && (
          <div className="mermaid-overlay">
            <span className="spinner" />
            Rendering diagram…
          </div>
        )}

        {renderError && !isRendering && (
          <div className="mermaid-error">
            <strong>Diagram render error</strong>
            <div className="mermaid-error-text">{renderError}</div>
            {!canAttemptFix && (
              <div className="mermaid-error-hint">
                {!sessionId
                  ? 'Start or restore a session to enable auto-fix.'
                  : 'Mermaid renderer failed to load. Check network access and refresh.'}
              </div>
            )}
            {(shouldAutoFix || isAutoFixing) && (
              <div className="mermaid-error-hint">
                <span className="spinner spinner-dark" style={{ marginRight: 8 }} />
                Auto-fixing diagram…
              </div>
            )}
            {showManualFix && !isFixing && (
              <button className="btn btn-primary btn-sm" onClick={fixDiagram} disabled={fixAttempts >= 5}>
                Fix diagram
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
