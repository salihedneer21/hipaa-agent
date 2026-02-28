import { useMemo, useState } from 'react';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  Network,
  Shield,
  Wrench,
} from 'lucide-react';
import type { Finding, ResolvedFinding } from '../types';

interface FindingsPanelProps {
  findings: Finding[];
  resolvedFindings?: ResolvedFinding[];
  selectedFile: string | null;
  onSelectFinding: (selection: { file: string; lines: number[] }) => void;
  onFixFinding?: (findingId: string) => void;
  onViewDiagram?: (findingId: string) => void;
}

const severityIcons = {
  critical: <AlertCircle size={14} className="severity-icon critical" />,
  high: <AlertTriangle size={14} className="severity-icon high" />,
  medium: <Info size={14} className="severity-icon medium" />,
  low: <CheckCircle size={14} className="severity-icon low" />,
};

function FindingCard({
  finding,
  onSelectFinding,
  onFixFinding,
  onViewDiagram,
  status,
}: {
  finding: Finding;
  onSelectFinding: (selection: { file: string; lines: number[] }) => void;
  onFixFinding?: (findingId: string) => void;
  onViewDiagram?: (findingId: string) => void;
  status: 'open' | 'resolved';
}) {
  const [isOpen, setIsOpen] = useState(false);

  const lines = useMemo(() => {
    const all = (finding.locations || [])
      .map(l => l.line)
      .filter(n => Number.isFinite(n) && n > 0);
    return Array.from(new Set(all)).sort((a, b) => a - b);
  }, [finding.locations]);

  const isResolved = status === 'resolved';
  const hasActions = Boolean((onFixFinding && !isResolved) || onViewDiagram);
  const hasDetails = Boolean(
    finding.whyItMatters ||
    finding.howItHappens ||
    finding.properFix ||
    finding.hipaaReference ||
    hasActions
  );
  const icon = isResolved
    ? <CheckCircle size={14} className="severity-icon resolved" />
    : severityIcons[finding.severity];

  return (
    <div className={`finding-card ${finding.severity} ${isResolved ? 'resolved' : ''}`}>
      <div
        className="finding-card-header"
        role="button"
        tabIndex={0}
        onClick={() => onSelectFinding({ file: finding.file, lines })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onSelectFinding({ file: finding.file, lines });
        }}
        title="Open in editor"
      >
        {icon}
        <span className="finding-title">{finding.title || finding.ruleName || 'Security Issue'}</span>
        {finding.confidence && (
          <span className={`finding-confidence ${finding.confidence}`}>{finding.confidence}</span>
        )}
        {isResolved && (
          <span className="finding-patch-badge" title="This finding is marked as resolved after re-verification">
            Patched
          </span>
        )}
        {lines.length > 1 && (
          <span className="finding-count">{lines.length} lines</span>
        )}
      </div>

      <div className="finding-meta">
        <span className="finding-file">{finding.file}</span>
      </div>

      <p className="finding-description">{finding.issue}</p>

      <div className="finding-lines">
        {(isOpen ? lines : lines.slice(0, 6)).map(line => {
          const loc = (finding.locations || []).find(l => l.line === line);
          const snippet = loc?.code ? ` — ${loc.code}` : '';
          return (
            <button
              key={line}
              className="finding-line-btn"
              onClick={() => onSelectFinding({ file: finding.file, lines: [line, ...lines.filter(l => l !== line)] })}
              title={`Go to line ${line}`}
            >
              <ChevronRight size={12} />
              Line {line}{snippet}
            </button>
          );
        })}
        {!isOpen && lines.length > 6 && (
          <span className="finding-more-lines">+{lines.length - 6} more</span>
        )}
      </div>

      <div className="finding-fix">
        {finding.remediation}
      </div>

      {hasDetails && (
        <Collapsible.Root open={isOpen} onOpenChange={setIsOpen}>
          <Collapsible.Trigger className="finding-details-trigger">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{isOpen ? 'Hide Details' : 'Details'}</span>
          </Collapsible.Trigger>
          <Collapsible.Content className="finding-details-content">
            {finding.whyItMatters && (
              <div className="finding-detail-section">
                <div className="finding-detail-header">
                  <Shield size={14} />
                  <span>Why It Matters</span>
                </div>
                <p>{finding.whyItMatters}</p>
              </div>
            )}
            {finding.howItHappens && (
              <div className="finding-detail-section">
                <div className="finding-detail-header">
                  <BookOpen size={14} />
                  <span>How It Happens</span>
                </div>
                <p>{finding.howItHappens}</p>
              </div>
            )}
            {finding.properFix && (
              <div className="finding-detail-section">
                <div className="finding-detail-header">
                  <Wrench size={14} />
                  <span>Proper Fix</span>
                </div>
                <p>{finding.properFix}</p>
              </div>
            )}
            {finding.hipaaReference && (
              <div className="finding-detail-reference">
                <FileText size={12} />
                <span>{finding.hipaaReference}</span>
              </div>
            )}

            {((onFixFinding && !isResolved) || onViewDiagram) && (
              <div className="finding-diagram-actions">
                {onFixFinding && !isResolved && (
                  <button className="btn btn-primary btn-sm" onClick={() => onFixFinding(finding.id)}>
                    <Wrench size={14} />
                    Suggest Fix
                  </button>
                )}
                {onViewDiagram && (
                  <button className="btn btn-secondary btn-sm" onClick={() => onViewDiagram(finding.id)}>
                    <Network size={14} />
                    View Diagram
                  </button>
                )}
              </div>
            )}
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </div>
  );
}

export function FindingsPanel({ findings, resolvedFindings = [], selectedFile, onSelectFinding, onFixFinding, onViewDiagram }: FindingsPanelProps) {
  const openFindings = selectedFile ? findings.filter(f => f.file === selectedFile) : findings;
  const doneFindings = useMemo(() => {
    const filtered = selectedFile ? resolvedFindings.filter(f => f.file === selectedFile) : resolvedFindings;
    return [...filtered].sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));
  }, [resolvedFindings, selectedFile]);

  const groupedBySeverity = useMemo(() => ({
    critical: openFindings.filter(f => f.severity === 'critical'),
    high: openFindings.filter(f => f.severity === 'high'),
    medium: openFindings.filter(f => f.severity === 'medium'),
    low: openFindings.filter(f => f.severity === 'low'),
  }), [openFindings]);

  if (openFindings.length === 0 && doneFindings.length === 0) {
    return (
      <div className="findings-panel empty">
        <CheckCircle size={40} className="empty-icon" />
        <h3>No Issues Found</h3>
        <p>{selectedFile ? 'No findings for this file' : 'Run an analysis to see findings'}</p>
      </div>
    );
  }

  return (
    <div className="findings-panel">
      <div className="findings-header">
        <h3>{selectedFile ? `Findings in ${selectedFile.split('/').pop()}` : 'All Findings'}</h3>
        <p className="findings-count">{openFindings.length} open • {doneFindings.length} done</p>
        <div className="findings-summary">
          {groupedBySeverity.critical.length > 0 && (
            <span className="badge critical">{groupedBySeverity.critical.length} Critical</span>
          )}
          {groupedBySeverity.high.length > 0 && (
            <span className="badge high">{groupedBySeverity.high.length} High</span>
          )}
          {groupedBySeverity.medium.length > 0 && (
            <span className="badge medium">{groupedBySeverity.medium.length} Medium</span>
          )}
          {groupedBySeverity.low.length > 0 && (
            <span className="badge low">{groupedBySeverity.low.length} Low</span>
          )}
        </div>
      </div>

      <ScrollArea.Root className="scroll-area-root" style={{ flex: 1 }}>
        <ScrollArea.Viewport className="scroll-area-viewport">
          <div className="findings-list">
            {openFindings.length > 0 && (
              <>
                <div className="findings-section-title">Not done</div>
                {(['critical', 'high', 'medium', 'low'] as const).map(severity => (
                  groupedBySeverity[severity].map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      onSelectFinding={onSelectFinding}
                      onFixFinding={onFixFinding}
                      onViewDiagram={onViewDiagram}
                      status="open"
                    />
                  ))
                ))}
              </>
            )}

            {doneFindings.length > 0 && (
              <>
                <div className="findings-section-title done">Done</div>
                {doneFindings.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    onSelectFinding={onSelectFinding}
                    onFixFinding={onFixFinding}
                    onViewDiagram={onViewDiagram}
                    status="resolved"
                  />
                ))}
              </>
            )}
          </div>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="scroll-area-scrollbar" orientation="vertical">
          <ScrollArea.Thumb className="scroll-area-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
