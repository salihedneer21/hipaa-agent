import { useState, useCallback, useRef, useEffect } from 'react';

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

interface AnalysisResult {
  totalFiles: number;
  analyzedFiles: number;
  totalFindings: number;
  findingsBySeverity: {
    critical: Finding[];
    high: Finding[];
    medium: Finding[];
    low: Finding[];
  };
  allFindings: Finding[];
}

interface Patch {
  file: string;
  patchedContent: string | null;
  changes: string[];
  explanation: string;
}

interface PatchResult {
  totalFiles: number;
  patchesGenerated: number;
  patches: Patch[];
}

interface RepoFile {
  path: string;
  content: string;
}

interface AnalysisResponse {
  repoUrl: string;
  readme: string | null;
  filesAnalyzed: number;
  files: RepoFile[];
  analysis: AnalysisResult;
  patches: PatchResult | null;
}

interface SessionStatus {
  status: 'pending' | 'analyzing' | 'patching' | 'complete' | 'error';
  progress: number;
  message: string;
  result?: AnalysisResponse;
  error?: string;
}

export function useAnalysis() {
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [result, setResult] = useState<AnalysisResponse | null>(null);
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
      const response = await fetch(`/api/analyze/${sessionId}`);
      const data: SessionStatus = await response.json();

      setProgress(data.progress);
      setStatusMessage(data.message);

      if (data.status === 'complete' && data.result) {
        clearPoll();
        setResult(data.result);
        setIsLoading(false);
      } else if (data.status === 'error') {
        clearPoll();
        setError(data.error || 'Analysis failed');
        setIsLoading(false);
      }
    } catch {
      clearPoll();
      setError('Failed to get analysis status');
      setIsLoading(false);
    }
  }, [clearPoll]);

  const analyze = useCallback(async (repoUrl: string, generatePatches: boolean = true) => {
    setIsLoading(true);
    setProgress(0);
    setStatusMessage('Starting analysis...');
    setResult(null);
    setError(null);
    clearPoll();

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl, generatePatches }),
      });

      if (!response.ok) {
        throw new Error('Failed to start analysis');
      }

      const { sessionId } = await response.json();

      // Start polling
      pollIntervalRef.current = setInterval(() => {
        pollStatus(sessionId);
      }, 1000);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
      setIsLoading(false);
    }
  }, [clearPoll, pollStatus]);

  const reset = useCallback(() => {
    clearPoll();
    setIsLoading(false);
    setProgress(0);
    setStatusMessage('');
    setResult(null);
    setError(null);
  }, [clearPoll]);

  return {
    analyze,
    reset,
    isLoading,
    progress,
    statusMessage,
    result,
    error,
  };
}
