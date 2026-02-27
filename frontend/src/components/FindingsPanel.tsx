import * as ScrollArea from '@radix-ui/react-scroll-area';
import { AlertTriangle, AlertCircle, Info, CheckCircle } from 'lucide-react';

interface Finding {
  ruleId: string;
  ruleName: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  code?: string;
  issue: string;
  remediation: string;
}

interface FindingsPanelProps {
  findings: Finding[];
  selectedFile: string | null;
  onSelectFinding: (finding: Finding) => void;
}

const severityIcons = {
  critical: <AlertCircle size={14} className="severity-icon critical" />,
  high: <AlertTriangle size={14} className="severity-icon high" />,
  medium: <Info size={14} className="severity-icon medium" />,
  low: <CheckCircle size={14} className="severity-icon low" />,
};

export function FindingsPanel({ findings, selectedFile, onSelectFinding }: FindingsPanelProps) {
  const filteredFindings = selectedFile
    ? findings.filter(f => f.file === selectedFile)
    : findings;

  const groupedFindings = {
    critical: filteredFindings.filter(f => f.severity === 'critical'),
    high: filteredFindings.filter(f => f.severity === 'high'),
    medium: filteredFindings.filter(f => f.severity === 'medium'),
    low: filteredFindings.filter(f => f.severity === 'low'),
  };

  if (filteredFindings.length === 0) {
    return (
      <div className="findings-panel empty">
        <CheckCircle size={40} className="empty-icon" />
        <h3>No Issues Found</h3>
        <p>{selectedFile ? 'This file is HIPAA compliant' : 'Select a file to view issues'}</p>
      </div>
    );
  }

  return (
    <div className="findings-panel">
      <div className="findings-header">
        <h3>Issues {selectedFile && `in ${selectedFile.split('/').pop()}`}</h3>
        <div className="findings-summary">
          {groupedFindings.critical.length > 0 && (
            <span className="badge critical">{groupedFindings.critical.length} Critical</span>
          )}
          {groupedFindings.high.length > 0 && (
            <span className="badge high">{groupedFindings.high.length} High</span>
          )}
          {groupedFindings.medium.length > 0 && (
            <span className="badge medium">{groupedFindings.medium.length} Medium</span>
          )}
          {groupedFindings.low.length > 0 && (
            <span className="badge low">{groupedFindings.low.length} Low</span>
          )}
        </div>
      </div>

      <ScrollArea.Root className="scroll-area-root" style={{ flex: 1 }}>
        <ScrollArea.Viewport className="scroll-area-viewport">
          <div className="findings-list">
            {(['critical', 'high', 'medium', 'low'] as const).map(severity => (
              groupedFindings[severity].map((finding, index) => (
                <div
                  key={`${severity}-${index}`}
                  className={`finding-card ${severity}`}
                  onClick={() => onSelectFinding(finding)}
                >
                  <div className="finding-card-header">
                    {severityIcons[severity]}
                    <span className="finding-title">{finding.ruleName || 'Security Issue'}</span>
                    <span className="finding-line">:{finding.line}</span>
                  </div>
                  <p className="finding-description">{finding.issue}</p>
                  <div className="finding-fix">
                    {finding.remediation}
                  </div>
                </div>
              ))
            ))}
          </div>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="scroll-area-scrollbar" orientation="vertical">
          <ScrollArea.Thumb className="scroll-area-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
