import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  FileCode,
  Shield,
  GitBranch,
  Loader2,
} from 'lucide-react';
import type { Diagram, Finding, ResolvedFinding, ThirdPartyService, ThirdPartyBaaConfirmationStatus } from '../types';
import { ThirdPartyBAADeck } from './ThirdPartyBAADeck';
import { MermaidViewer } from './MermaidViewer';
import { apiFetch } from '../api';

type Tab = 'issues' | 'baa';

const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const severityIcon = (severity: string) => {
  if (severity === 'critical') return <AlertCircle size={14} className="severity-icon critical" />;
  if (severity === 'high') return <AlertTriangle size={14} className="severity-icon high" />;
  if (severity === 'medium') return <AlertTriangle size={14} className="severity-icon medium" />;
  return <CheckCircle size={14} className="severity-icon low" />;
};

function categoryLabel(ruleId: string): string {
  if (ruleId.startsWith('notifications_')) return 'Notifications & Communications';
  if (ruleId.startsWith('auth_')) return 'Authentication & Access Control';
  if (ruleId.startsWith('client_storage_')) return 'Client-Side Data Storage';
  if (ruleId.startsWith('audit_')) return 'Auditing';
  return 'Other';
}

function matchServiceByIntegration(services: ThirdPartyService[], integrationName: string): ThirdPartyService | null {
  const needle = (integrationName || '').trim().toLowerCase();
  if (!needle) return null;
  for (const svc of services || []) {
    if ((svc.id || '').toLowerCase() === needle) return svc;
    if ((svc.name || '').toLowerCase() === needle) return svc;
    // Allow loose matching like "SendGrid" vs "sendgrid"
    if ((svc.name || '').toLowerCase().replace(/\s+/g, '') === needle.replace(/\s+/g, '')) return svc;
  }
  return null;
}

export function SecurityCenter({
  findings,
  resolvedFindings,
  thirdPartyServices,
  activeFindingId,
  sessionId,
  onSelectFinding,
  onOpenInWorkspace,
  onConfirmThirdParty,
  onDiagramUpdated,
}: {
  findings: Finding[];
  resolvedFindings: ResolvedFinding[];
  thirdPartyServices: ThirdPartyService[];
  activeFindingId: string | null;
  sessionId: string | null;
  onSelectFinding: (findingId: string) => void;
  onOpenInWorkspace: (findingId: string) => void;
  onConfirmThirdParty: (providerId: string, status: ThirdPartyBaaConfirmationStatus) => Promise<void>;
  onDiagramUpdated?: (diagram: Diagram) => void;
}) {
  const [tab, setTab] = useState<Tab>('issues');
  const didInitRef = useRef(false);

  const resolvedIds = useMemo(() => new Set((resolvedFindings || []).map(f => f.id)), [resolvedFindings]);

  const openFindings = useMemo(() => {
    return [...(findings || [])]
      .filter(f => !resolvedIds.has(f.id))
      .sort((a, b) => {
        const r = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
        if (r !== 0) return r;
        return (a.title || '').localeCompare(b.title || '');
      });
  }, [findings, resolvedIds]);

  const needsBaaReviewCount = useMemo(() => {
    return (thirdPartyServices || []).filter(s => (s.confirmation?.status || 'unknown') === 'unknown').length;
  }, [thirdPartyServices]);

  // Pick a default tab and finding when results load.
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (needsBaaReviewCount > 0) {
      setTab('baa');
      return;
    }
    setTab('issues');
    if (!activeFindingId && openFindings[0]?.id) onSelectFinding(openFindings[0].id);
  }, [activeFindingId, needsBaaReviewCount, onSelectFinding, openFindings]);

  const activeFinding = useMemo(() => {
    if (!activeFindingId) return openFindings[0] || null;
    return (findings || []).find(f => f.id === activeFindingId) || openFindings[0] || null;
  }, [activeFindingId, findings, openFindings]);

  return (
    <div className="security-center">
      <aside className="security-center-sidebar">
        <div className="security-center-brand">
          <Shield size={16} />
          <span>HIPAA Compliance</span>
        </div>

        <button
          type="button"
          className={`sc-nav-item ${tab === 'baa' ? 'active' : ''}`}
          onClick={() => setTab('baa')}
        >
          <span>Third-Party BAAs</span>
          <span className={`sc-count ${needsBaaReviewCount > 0 ? 'warn' : ''}`}>{needsBaaReviewCount}</span>
        </button>

        <div className="sc-section">
          <div className="sc-section-header">
            <span>Compliance Issues</span>
            <span className="sc-count">{openFindings.length}</span>
          </div>

          <div className="sc-list">
            {openFindings.slice(0, 120).map((f) => (
              <button
                key={f.id}
                type="button"
                className={`sc-finding-item ${f.id === activeFinding?.id ? 'active' : ''}`}
                onClick={() => {
                  setTab('issues');
                  onSelectFinding(f.id);
                }}
                title={`${f.file}:${f.locations?.[0]?.line || 1}`}
              >
                <span className={`sc-sev-dot ${f.severity}`} />
                <span className="sc-finding-title">{f.title || f.ruleName || 'Issue'}</span>
              </button>
            ))}
          </div>

          <div className="sc-section-header cleared">
            <span>Cleared</span>
            <span className="sc-count">{(resolvedFindings || []).length}</span>
          </div>
          <div className="sc-list cleared">
            {(resolvedFindings || []).slice(0, 80).map((f) => (
              <button
                key={f.id}
                type="button"
                className="sc-finding-item cleared"
                onClick={() => {
                  setTab('issues');
                  onSelectFinding(f.id);
                }}
                title="Resolved"
              >
                <CheckCircle size={14} className="severity-icon resolved" />
                <span className="sc-finding-title">{f.title || f.ruleName || 'Issue'}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="security-center-main">
        {tab === 'baa' ? (
          <ThirdPartyBAADeck services={thirdPartyServices || []} onConfirm={onConfirmThirdParty} />
        ) : activeFinding ? (
          <FindingReport
            finding={activeFinding}
            sessionId={sessionId}
            thirdPartyServices={thirdPartyServices || []}
            onOpenInWorkspace={onOpenInWorkspace}
            onConfirmThirdParty={onConfirmThirdParty}
            onDiagramUpdated={onDiagramUpdated}
          />
        ) : (
          <div className="security-center-empty">
            <CheckCircle size={40} className="empty-icon" />
            <h3>No issues found</h3>
            <p>Run an analysis to see findings.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function FindingReport({
  finding,
  sessionId,
  thirdPartyServices,
  onOpenInWorkspace,
  onConfirmThirdParty,
  onDiagramUpdated,
}: {
  finding: Finding;
  sessionId: string | null;
  thirdPartyServices: ThirdPartyService[];
  onOpenInWorkspace: (findingId: string) => void;
  onConfirmThirdParty: (providerId: string, status: ThirdPartyBaaConfirmationStatus) => Promise<void>;
  onDiagramUpdated?: (diagram: Diagram) => void;
}) {
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [diagramLoading, setDiagramLoading] = useState(false);
  const [diagramError, setDiagramError] = useState<string | null>(null);
  const loadedFindingIdRef = useRef<string | null>(null);

  const firstLoc = (finding.locations || [])[0] || null;
  const codeSnippet = firstLoc?.code ? firstLoc.code : '';
  const whereLine = firstLoc?.line || 1;

  const integrations = (finding.integrations || []).slice(0, 4);
  const linkedProvider = integrations.length > 0 ? matchServiceByIntegration(thirdPartyServices, integrations[0]!) : null;
  const providerStatus = linkedProvider?.confirmation?.status || 'unknown';
  const providerAvailability = linkedProvider?.baa?.availability || 'unknown';

  const loadDiagram = useCallback(async () => {
    if (!sessionId || diagramLoading) return;
    setDiagramLoading(true);
    setDiagramError(null);
    try {
      const response = await apiFetch(`/api/sessions/${sessionId}/diagrams/finding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId: finding.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to generate diagram');
      setDiagram(data.diagram as Diagram);
      loadedFindingIdRef.current = finding.id;
    } catch (e) {
      setDiagramError(e instanceof Error ? e.message : 'Failed to generate diagram');
    } finally {
      setDiagramLoading(false);
    }
  }, [sessionId, finding.id, diagramLoading]);

  // Reset diagram when finding changes
  useEffect(() => {
    if (loadedFindingIdRef.current !== finding.id) {
      setDiagram(null);
      setDiagramError(null);
      loadedFindingIdRef.current = null;
    }
  }, [finding.id]);

  const handleDiagramUpdated = useCallback((updatedDiagram: Diagram) => {
    setDiagram(updatedDiagram);
    onDiagramUpdated?.(updatedDiagram);
  }, [onDiagramUpdated]);

  return (
    <div className="finding-report">
      <div className="finding-report-header">
        <div className="finding-report-title-row">
          <span className="finding-report-severity">{severityIcon(finding.severity)}</span>
          <h2>{finding.title || finding.ruleName || 'Finding'}</h2>
        </div>
        <div className="finding-report-badges">
          <span className={`badge ${finding.severity}`}>{finding.severity.toUpperCase()}</span>
          <span className="badge neutral">{categoryLabel(finding.ruleId)}</span>
        </div>
      </div>

      <div className="finding-report-section">
        <div className="finding-report-section-title">Where we found it</div>
        <div className="finding-report-where">
          <div className="finding-report-file">
            <span className="finding-report-path">{finding.file}:{whereLine}</span>
          </div>
          {codeSnippet ? (
            <pre className="finding-report-code">
              <code>{codeSnippet}</code>
            </pre>
          ) : null}
          {(finding.locations || []).length > 1 ? (
            <div className="finding-report-more">
              +{(finding.locations || []).length - 1} more location{(finding.locations || []).length - 1 === 1 ? '' : 's'}
            </div>
          ) : null}
        </div>
      </div>

      <div className="finding-report-section">
        <div className="finding-report-section-title">Description</div>
        <p className="finding-report-text">{finding.issue}</p>
      </div>

      {finding.whyItMatters ? (
        <div className="finding-report-section">
          <div className="finding-report-section-title">Why this matters</div>
          <p className="finding-report-text">{finding.whyItMatters}</p>
        </div>
      ) : null}

      <div className="finding-report-section">
        <div className="finding-report-section-title">How to resolve</div>
        <div className="finding-report-actions">
          {linkedProvider ? (
            <div className="resolve-card">
              <div className="resolve-card-title">Confirm BAA</div>
              <div className="resolve-card-body">
                Confirm you have a signed Business Associate Agreement with <strong>{linkedProvider.name}</strong>.
                <div className="resolve-card-meta">
                  <span className={`baa-badge ${providerAvailability}`}>{providerAvailability}</span>
                  <span className={`baa-status ${providerStatus}`}>{providerStatus.replace('_', ' ')}</span>
                </div>
              </div>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => onConfirmThirdParty(linkedProvider.id, 'confirmed')}
                disabled={providerStatus === 'confirmed'}
              >
                {providerStatus === 'confirmed' ? 'BAA Confirmed' : 'Confirm BAA in Place'}
              </button>
            </div>
          ) : null}

          <div className="resolve-card">
            <div className="resolve-card-title">Fix with Specode AI</div>
            <div className="resolve-card-body">
              Open the relevant code and highlight the exact location so you can implement a safe fix.
            </div>
            <button className="btn btn-secondary" type="button" onClick={() => onOpenInWorkspace(finding.id)}>
              <FileCode size={16} />
              Fix with Specode AI
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {finding.properFix ? (
        <div className="finding-report-section">
          <div className="finding-report-section-title">Suggested fix</div>
          <p className="finding-report-text">{finding.properFix}</p>
        </div>
      ) : null}

      <div className="finding-report-section finding-diagram-section">
        <div className="finding-report-section-title">
          <GitBranch size={16} />
          Data Flow Diagram
        </div>
        {diagram ? (
          <div className="finding-diagram-container">
            <MermaidViewer
              diagram={diagram}
              sessionId={sessionId}
              onDiagramUpdated={handleDiagramUpdated}
            />
          </div>
        ) : diagramError ? (
          <div className="finding-diagram-error">
            <span>{diagramError}</span>
            <button className="btn btn-secondary btn-sm" onClick={loadDiagram} disabled={diagramLoading}>
              Retry
            </button>
          </div>
        ) : (
          <div className="finding-diagram-placeholder">
            <p>Generate a visual diagram showing how this issue affects data flow.</p>
            <button
              className="btn btn-secondary"
              onClick={loadDiagram}
              disabled={diagramLoading || !sessionId}
            >
              {diagramLoading ? (
                <>
                  <Loader2 size={16} className="spinning" />
                  Generating…
                </>
              ) : (
                <>
                  <GitBranch size={16} />
                  Generate Diagram
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {finding.hipaaReference ? (
        <div className="finding-report-reference">{finding.hipaaReference}</div>
      ) : null}
    </div>
  );
}
