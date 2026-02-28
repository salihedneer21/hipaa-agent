import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Bug, RefreshCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { Diagram } from '../types';

declare global {
  interface Window {
    mermaid?: any;
  }
}

const MERMAID_CDN_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';

let mermaidLoading: Promise<any> | null = null;

async function loadMermaid(): Promise<any> {
  if (typeof window === 'undefined') return null;
  if (window.mermaid) return window.mermaid;
  if (mermaidLoading) return mermaidLoading;

  mermaidLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-mermaid-loader="true"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.mermaid));
      existing.addEventListener('error', () => reject(new Error('Failed to load Mermaid')));
      return;
    }

    const script = document.createElement('script');
    script.src = MERMAID_CDN_SRC;
    script.async = true;
    script.dataset.mermaidLoader = 'true';
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => reject(new Error('Failed to load Mermaid'));
    document.head.appendChild(script);
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

  const AUTO_FIX_MAX_ATTEMPTS = 2;

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
        }
        if (typeof bindFunctions === 'function') {
          bindFunctions(svgWrapRef.current);
        }
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
      const response = await fetch(`/api/sessions/${sessionId}/diagrams/fix`, {
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
    fixDiagram();
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

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const direction = e.deltaY < 0 ? 1 : -1;
    const nextScale = clamp(scale * (direction > 0 ? 1.12 : 0.9), 0.25, 4);
    const ratio = nextScale / scale;

    setOffset(prev => ({
      x: cx - ratio * (cx - prev.x),
      y: cy - ratio * (cy - prev.y),
    }));
    setScale(nextScale);
  };

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  return (
    <div className="mermaid-viewer">
      <div className="mermaid-toolbar">
        <button className="btn btn-secondary btn-sm" onClick={() => setScale(s => clamp(s * 1.15, 0.25, 4))} title="Zoom in">
          <ZoomIn size={14} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setScale(s => clamp(s * 0.87, 0.25, 4))} title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={resetView} title="Reset view">
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
        onWheel={onWheel}
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
