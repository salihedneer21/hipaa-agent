import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle, Clock, Copy, GitCommit, X } from 'lucide-react';
import type { SessionMeta } from '../types';

function formatRepo(repoUrl: string): string {
  const raw = repoUrl || '';
  if (/^file:\/\//i.test(raw)) {
    try {
      const withoutScheme = raw.replace(/^file:\/\//i, '');
      return decodeURIComponent(withoutScheme);
    } catch {
      return raw;
    }
  }
  return raw.replace(/^https?:\/\/github\.com\//i, '');
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function SessionsDialog({
  open,
  onOpenChange,
  currentSessionId,
  onResumeSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSessionId: string | null;
  onResumeSession: (sessionId: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const response = await fetch('/api/sessions', { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load sessions');
        if (!cancelled) setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Failed to load sessions');
        setSessions([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open]);

  useEffect(() => {
    if (!copiedId) return;
    const t = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(t);
  }, [copiedId]);

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [sessions]);

  const handleCopy = async (sessionId: string) => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopiedId(sessionId);
    } catch {
      // ignore
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content sessions-dialog">
          <div className="dialog-header">
            <Dialog.Title className="dialog-title">Session History</Dialog.Title>
            <Dialog.Close className="dialog-close" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="dialog-body">
            {loadError && (
              <div className="dialog-error">
                <strong>Error:</strong> {loadError}
              </div>
            )}

            {isLoading && (
              <div className="dialog-loading">
                <span className="spinner" />
                Loading sessions…
              </div>
            )}

            {!isLoading && sorted.length === 0 && !loadError && (
              <div className="sessions-empty">
                <CheckCircle size={32} />
                <div>
                  <strong>No saved sessions yet</strong>
                  <p>Run an analysis to create a restorable session.</p>
                </div>
              </div>
            )}

            {!isLoading && sorted.length > 0 && (
              <div className="sessions-list">
                {sorted.map(session => {
                  const isActive = currentSessionId === session.sessionId;
                  const hasFindings = session.findings?.total > 0;

                  return (
                    <div
                      key={session.sessionId}
                      className={`session-item ${isActive ? 'active' : ''} ${session.status === 'error' ? 'error' : ''}`}
                    >
                      <div className="session-main">
                        <div className="session-row">
                          <span className="session-repo" title={session.repoUrl}>
                            {formatRepo(session.repoUrl)}
                          </span>
                          <span className={`session-status ${session.status}`}>
                            {session.status === 'error' ? 'Error' : 'Complete'}
                          </span>
                        </div>

                        <div className="session-meta">
                          <span className="session-meta-item">
                            <Clock size={12} />
                            {formatDate(session.createdAt)}
                          </span>
                          {session.commitHash && (
                            <span className="session-meta-item">
                              <GitCommit size={12} />
                              {session.commitHash.slice(0, 8)}
                            </span>
                          )}
                          <button
                            type="button"
                            className={`session-id ${copiedId === session.sessionId ? 'copied' : ''}`}
                            onClick={() => handleCopy(session.sessionId)}
                            title="Copy session id"
                          >
                            <Copy size={12} />
                            {copiedId === session.sessionId ? 'Copied' : session.sessionId}
                          </button>
                        </div>

                        <div className="session-stats">
                          <span className="session-stat">{session.filesAnalyzed} files</span>
                          <span className="session-stat">{session.patchesGenerated} patches</span>
                          <span className="session-stat">{session.diagrams?.length || 0} diagrams</span>
                        </div>

                        <div className="sessions-badges">
                          {!hasFindings ? (
                            <span className="badge low">0 Findings</span>
                          ) : (
                            <>
                              {session.findings.critical > 0 && (
                                <span className="badge critical">{session.findings.critical} Critical</span>
                              )}
                              {session.findings.high > 0 && (
                                <span className="badge high">{session.findings.high} High</span>
                              )}
                              {session.findings.medium > 0 && (
                                <span className="badge medium">{session.findings.medium} Medium</span>
                              )}
                              {session.findings.low > 0 && (
                                <span className="badge low">{session.findings.low} Low</span>
                              )}
                              <span className="badge neutral">{session.findings.total} Total</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="session-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => {
                            onOpenChange(false);
                            onResumeSession(session.sessionId);
                          }}
                        >
                          {isActive ? 'Open (Current)' : 'Open'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
