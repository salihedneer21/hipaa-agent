import { useMemo, useState } from 'react';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronRight, FileText, Network } from 'lucide-react';
import type { Diagram } from '../types';

interface DiagramsBrowserProps {
  diagrams: Diagram[];
  selectedDiagram: string | null;
  onSelectDiagram: (name: string) => void;
}

export function DiagramsBrowser({ diagrams, selectedDiagram, onSelectDiagram }: DiagramsBrowserProps) {
  const [showFindingDiagrams, setShowFindingDiagrams] = useState(false);

  const { repoDiagrams, findingDiagrams } = useMemo(() => {
    const repoDiagrams = diagrams.filter(d => !d.findingId);
    const findingDiagrams = diagrams.filter(d => d.findingId);
    return { repoDiagrams, findingDiagrams };
  }, [diagrams]);

  return (
    <div className="diagrams-browser">
      <div className="diagrams-browser-header">
        <Network size={14} />
        <span>Diagrams</span>
        <span className="file-count">{repoDiagrams.length}</span>
        {findingDiagrams.length > 0 && (
          <span className="file-count file-count-muted" title="Finding-specific diagrams (available on finding cards)">
            +{findingDiagrams.length}
          </span>
        )}
      </div>

      {diagrams.length === 0 ? (
        <div className="diagrams-empty">
          <p>No diagrams generated.</p>
        </div>
      ) : (
        <ScrollArea.Root className="scroll-area-root">
          <ScrollArea.Viewport className="scroll-area-viewport">
            <div className="diagrams-list">
              {repoDiagrams.map(d => (
                <div
                  key={d.name}
                  className={`diagram-item ${selectedDiagram === d.name ? 'selected' : ''}`}
                  onClick={() => onSelectDiagram(d.name)}
                  title={d.title}
                >
                  <FileText size={14} className="file-icon" />
                  <span className="file-name">{d.title || d.name}</span>
                </div>
              ))}

              {findingDiagrams.length > 0 && (
                <Collapsible.Root open={showFindingDiagrams} onOpenChange={setShowFindingDiagrams} className="diagrams-finding-section">
                  <Collapsible.Trigger className="diagrams-section-trigger" title="Finding diagrams are best viewed from the finding card for context">
                    {showFindingDiagrams ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>Finding diagrams</span>
                    <span className="diagrams-section-count">{findingDiagrams.length}</span>
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    {findingDiagrams.map(d => (
                      <div
                        key={d.name}
                        className={`diagram-item diagram-item-finding ${selectedDiagram === d.name ? 'selected' : ''}`}
                        onClick={() => onSelectDiagram(d.name)}
                        title={d.title}
                      >
                        <FileText size={14} className="file-icon" />
                        <span className="file-name">{d.title || d.name}</span>
                      </div>
                    ))}
                  </Collapsible.Content>
                </Collapsible.Root>
              )}
            </div>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar className="scroll-area-scrollbar" orientation="vertical">
            <ScrollArea.Thumb className="scroll-area-thumb" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      )}
    </div>
  );
}
