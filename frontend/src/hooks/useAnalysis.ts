import { useState, useCallback, useRef, useEffect } from 'react';
import type { AnalysisResponse, AnalysisResult, Diagram, Patch, ResolvedFinding, SessionStatus } from '../types';
import { apiFetch } from '../api';

const LAST_SESSION_ID_KEY = 'hipaa-agent:lastSessionId';

export function useAnalysis() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearPoll();
  }, [clearPoll]);

  const pollStatus = useCallback(async (sessionId: string) => {
    try {
      const response = await apiFetch(`/api/analyze/${sessionId}`);
      if (!response.ok) {
        throw new Error('Failed to get analysis status');
      }
      const data: SessionStatus = await response.json();

      setProgress(data.progress);
      setStatusMessage(data.message);
      setSessionStatus(data);

      if (data.status === 'complete' && data.result) {
        clearPoll();
        setResult(data.result);
        setSessionId(data.result.sessionId);
        setIsLoading(false);
        setSessionStatus(null);
      } else if (data.status === 'error') {
        clearPoll();
        setError(data.error || 'Analysis failed');
        setIsLoading(false);
        setSessionStatus(null);
      }
    } catch {
      clearPoll();
      setError('Failed to get analysis status');
      setIsLoading(false);
      setSessionStatus(null);
    }
  }, [clearPoll]);

  const resume = useCallback((id: string) => {
    if (!id) return;
    setSessionId(id);
    setIsLoading(true);
    setProgress(0);
    setStatusMessage('Restoring session...');
    setResult(null);
    setSessionStatus(null);
    setError(null);
    localStorage.setItem(LAST_SESSION_ID_KEY, id);
    clearPoll();

    pollIntervalRef.current = setInterval(() => {
      pollStatus(id);
    }, 1000);
    pollStatus(id);
  }, [clearPoll, pollStatus]);

  const analyze = useCallback(async (repoUrl: string, options?: { githubInstallationId?: number | null }) => {
    setIsLoading(true);
    setProgress(0);
    setStatusMessage('Starting analysis...');
    setResult(null);
    setSessionStatus(null);
    setError(null);
    clearPoll();

    try {
      const response = await apiFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl,
          githubInstallationId: options?.githubInstallationId ?? undefined,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to start analysis');
      }

      const { sessionId } = await response.json();
      setSessionId(sessionId);
      localStorage.setItem(LAST_SESSION_ID_KEY, sessionId);

      // Start polling
      pollIntervalRef.current = setInterval(() => {
        pollStatus(sessionId);
      }, 1000);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
      setIsLoading(false);
      setSessionStatus(null);
    }
  }, [clearPoll, pollStatus]);

  // Auto-restore last session on refresh.
  useEffect(() => {
    if (result || isLoading || sessionId) return;
    const last = localStorage.getItem(LAST_SESSION_ID_KEY);
    if (last) resume(last);
  }, [isLoading, result, resume, sessionId]);

  const reset = useCallback(() => {
    clearPoll();
    setIsLoading(false);
    setProgress(0);
    setStatusMessage('');
    setResult(null);
    setSessionStatus(null);
    setError(null);
    setSessionId(null);
    localStorage.removeItem(LAST_SESSION_ID_KEY);
  }, [clearPoll]);

  const upsertPatch = useCallback((patch: Patch) => {
    setResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        patches: [
          ...prev.patches.filter(p => p.file !== patch.file),
          patch,
        ],
      };
    });
  }, []);

  const upsertDiagram = useCallback((diagram: Diagram) => {
    setResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        diagrams: [
          ...prev.diagrams.filter(d => d.name !== diagram.name),
          diagram,
        ],
      };
    });
  }, []);

  const updateAnalysis = useCallback((analysis: AnalysisResult) => {
    setResult(prev => {
      if (!prev) return prev;
      return { ...prev, analysis };
    });
  }, []);

  const updateFileTree = useCallback((fileTree: string[]) => {
    setResult(prev => {
      if (!prev) return prev;
      return { ...prev, fileTree };
    });
  }, []);

  const updateResolvedFindings = useCallback((resolvedFindings: ResolvedFinding[]) => {
    setResult(prev => {
      if (!prev) return prev;
      return { ...prev, resolvedFindings };
    });
  }, []);

  return {
    analyze,
    resume,
    reset,
    upsertPatch,
    upsertDiagram,
    updateAnalysis,
    updateFileTree,
    updateResolvedFindings,
    sessionId,
    isLoading,
    progress,
    statusMessage,
    sessionStatus,
    result,
    error,
  };
}
