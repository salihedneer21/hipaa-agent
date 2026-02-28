import { useState, useEffect, useMemo, useRef } from 'react';
import * as Progress from '@radix-ui/react-progress';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import * as Dialog from '@radix-ui/react-dialog';
import { Header } from './components/Header';
import { FileBrowser } from './components/FileBrowser';
import { CodeEditor, DiffViewer, getLanguageFromPath } from './components/CodeEditor';
import { FindingsPanel } from './components/FindingsPanel';
import { DiagramsBrowser } from './components/DiagramsBrowser';
import { MermaidViewer } from './components/MermaidViewer';
import { SessionsDialog } from './components/SessionsDialog';
import { useAnalysis } from './hooks/useAnalysis';
import { Eye, GitCompare, History, Shield, Search, Wrench, X } from 'lucide-react';
import type { Diagram, Patch, SessionStatus } from './types';

type ViewMode = 'current' | 'original' | 'diff';
type PreviewIssue = NonNullable<SessionStatus['issuesPreview']>[number];

// Dynamic progress messages based on stage
const PROGRESS_MESSAGES: Record<string, string[]> = {
  pending: ['Initializing scanner...', 'Preparing analysis engine...'],
  analyzing: [
    'Scanning for PHI exposure risks...',
    'Checking encryption patterns...',
    'Analyzing authentication flows...',
    'Inspecting data transmission...',
    'Validating access controls...',
    'Reviewing audit logging...',
    'Checking session management...',
  ],
  finalizing: [
    'Summarizing findings...',
    'Generating architecture diagrams...',
    'Mapping sensitive data flows...',
    'Preparing session snapshot...',
  ],
};

// Skeleton Loading Component
function SkeletonLoader({
  progress,
  statusMessage,
  sessionId,
  sessionStatus,
}: {
  progress: number;
  statusMessage: string;
  sessionId: string | null;
  sessionStatus: SessionStatus | null;
}) {
  const [displayMessage, setDisplayMessage] = useState(statusMessage);
  const [previewFilePath, setPreviewFilePath] = useState<string>('');
  const [previewFileContent, setPreviewFileContent] = useState<string>('');
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [isPreviewSwitching, setIsPreviewSwitching] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const previewFilePathRef = useRef('');
  const messageIndexRef = useRef(0);
  const latestWantedFileRef = useRef('');
  const previewCacheRef = useRef(new Map<string, { content: string; truncated: boolean }>());
  const previewCacheOrderRef = useRef<string[]>([]);
  const switchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    previewFilePathRef.current = previewFilePath;
  }, [previewFilePath]);

  // Rotate through messages
  useEffect(() => {
    const stage = progress < 30 ? 'pending' : progress < 80 ? 'analyzing' : 'finalizing';
    const messages = PROGRESS_MESSAGES[stage];

    const interval = setInterval(() => {
      // If backend provides a meaningful status message, prefer that over rotating filler text.
      if (statusMessage && statusMessage !== 'Starting analysis...') return;
      messageIndexRef.current = (messageIndexRef.current + 1) % messages.length;
      setDisplayMessage(messages[messageIndexRef.current] || messages[0]);
    }, 2500);

    return () => clearInterval(interval);
  }, [progress, statusMessage]);

  // Use actual status message when available
  useEffect(() => {
    if (statusMessage && statusMessage !== 'Starting analysis...') {
      setDisplayMessage(statusMessage);
    }
  }, [statusMessage]);

  useEffect(() => {
    const wanted = sessionStatus?.currentFile || '';
    if (!sessionId || !wanted) return;
    latestWantedFileRef.current = wanted;

    const cached = previewCacheRef.current.get(wanted);
    if (!cached) {
      fetchAbortRef.current?.abort();
      const controller = new AbortController();
      fetchAbortRef.current = controller;
      setIsPreviewLoading(true);

      fetch(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(wanted)}&maxBytes=8000`, { signal: controller.signal })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to load file preview');
          }
          return data as { content?: string; truncated?: boolean };
        })
        .then((data) => {
          const content = typeof data.content === 'string' ? data.content : '';
          const truncated = Boolean(data.truncated);
          previewCacheRef.current.set(wanted, { content, truncated });
          previewCacheOrderRef.current.push(wanted);

          // Cap memory usage.
          while (previewCacheOrderRef.current.length > 40) {
            const old = previewCacheOrderRef.current.shift();
            if (old && old !== wanted) previewCacheRef.current.delete(old);
          }
        })
        .catch((e) => {
          if (e instanceof Error && e.name === 'AbortError') return;
        })
        .finally(() => {
          if (latestWantedFileRef.current === wanted) setIsPreviewLoading(false);
        });
    } else {
      setIsPreviewLoading(false);
    }

    const attemptSwitch = (triesLeft: number) => {
      if (latestWantedFileRef.current !== wanted) return;
      const next = previewCacheRef.current.get(wanted);
      if (!next) {
        if (triesLeft > 0) {
          retryTimeoutRef.current = setTimeout(() => attemptSwitch(triesLeft - 1), 140);
        }
        return;
      }

      if (previewFilePathRef.current === wanted) return;
      setIsPreviewSwitching(true);
      setTimeout(() => {
        setPreviewFilePath(wanted);
        setPreviewFileContent(next.content);
        setPreviewTruncated(next.truncated);
        setIsPreviewSwitching(false);
        setRecentFiles(prev => [wanted, ...prev.filter(p => p !== wanted)].slice(0, 12));
      }, 180);
    };

    if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current);
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    switchTimeoutRef.current = setTimeout(() => attemptSwitch(6), 420);

    return () => {
      if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [sessionId, sessionStatus?.currentFile]);

  const issues = sessionStatus?.issuesPreview || [];
  const codeLines = previewFilePath ? previewFileContent.split('\n').slice(0, 60) : [];
  const fileLabel = previewFilePath || sessionStatus?.currentFile || '';
  const linesToRender = codeLines.length > 0 ? codeLines : Array.from({ length: 28 }).map(() => '');

  const { previewLineSeverity, previewIssueCount, previewMaxSeverity } = useMemo(() => {
    const map = new Map<number, PreviewIssue['severity']>();
    let max: PreviewIssue['severity'] | null = null;
    const rank = (s: PreviewIssue['severity']) => (s === 'critical' ? 4 : s === 'high' ? 3 : s === 'medium' ? 2 : 1);

    if (!previewFilePath) {
      return { previewLineSeverity: map, previewIssueCount: 0, previewMaxSeverity: null as PreviewIssue['severity'] | null };
    }

    for (const issue of issues) {
      if (issue.file !== previewFilePath) continue;
      const line = Number(issue.line);
      if (!Number.isFinite(line) || line <= 0) continue;
      const existing = map.get(line);
      if (!existing || rank(issue.severity) > rank(existing)) {
        map.set(line, issue.severity);
      }
      if (!max || rank(issue.severity) > rank(max)) {
        max = issue.severity;
      }
    }

    return { previewLineSeverity: map, previewIssueCount: map.size, previewMaxSeverity: max };
  }, [issues, previewFilePath]);

  return (
    <div className="loading-overlay">
      {/* Skeleton Header */}
      <div className="loading-header">
        <img
          src="https://cdn.prod.website-files.com/66acb95cb4494fc16ceefb5c/66acbab0f2243846b02e7c79_Logo.svg"
          alt="Logo"
          className="brand-logo"
        />
        <div className="skeleton skeleton-input"></div>
        <div className="skeleton skeleton-btn"></div>
      </div>

      <div className="loading-main">
        {/* Skeleton Sidebar */}
        <div className="loading-sidebar">
          <div className="loading-files-header">
            <span>Files</span>
            <span className="loading-files-count">{sessionStatus?.totalFiles ?? '—'}</span>
          </div>
          <div className="loading-files-list">
            {recentFiles.length === 0 && (
              <>
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="skeleton-file-item">
                    <div className="skeleton skeleton-file-icon"></div>
                    <div className="skeleton skeleton-file-name" style={{ width: `${55 + Math.random() * 35}%` }}></div>
                  </div>
                ))}
              </>
            )}
            {recentFiles.map((file) => (
              <div
                key={file}
                className={`loading-file-item ${file === previewFilePath ? 'active' : ''}`}
                title={file}
              >
                <div className="loading-file-dot" />
                <span className="loading-file-name">{file}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Code Scanner */}
        <div className="loading-editor">
          <div className="code-scanner-container">
            <div className={`code-scanner ${isPreviewSwitching ? 'switching' : ''} ${previewFilePath ? 'has-preview' : ''}`}>
              <div className={`code-scanner-file ${isPreviewSwitching ? 'switching' : ''}`}>
                <span className="code-scanner-file-path">{fileLabel || 'Preparing file preview…'}</span>
                <span className="code-scanner-file-right">
                  {previewIssueCount > 0 && previewMaxSeverity && (
                    <span className={`code-scanner-issue-badge ${previewMaxSeverity}`}>
                      {previewIssueCount} issue{previewIssueCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {previewTruncated && <span className="code-scanner-trunc">preview</span>}
                  {isPreviewLoading && <span className="code-scanner-loading-dot" />}
                </span>
              </div>

              {linesToRender.map((line, i) => {
                const severity = previewLineSeverity.get(i + 1);
                return (
                  <div key={i} className={`code-line ${severity ? `issue ${severity}` : ''}`}>
                  <span className="line-number">{i + 1}</span>
                  <span className="line-content">{line || '\u00A0'}</span>
                </div>
                );
              })}
              <div className="scan-line"></div>
              <div className="scan-highlight"></div>
            </div>
          </div>
        </div>

        {/* Progress Panel */}
        <div className="loading-findings">
          <div className="progress-header">
            <h3>Scanning Repository</h3>
            <div className="progress-percentage">{Math.round(progress)}%</div>
            <Progress.Root className="progress-root" value={progress}>
              <Progress.Indicator
                className="progress-indicator"
                style={{ transform: `translateX(-${100 - progress}%)` }}
              />
            </Progress.Root>
            <p className="progress-message">{displayMessage}</p>
          </div>

          {issues.length > 0 && (
            <div className="detected-issues">
              <h4>Issues Detected</h4>
              {issues.map((issue, i) => (
                <div key={i} className="detected-issue">
                  <div className={`detected-issue-dot ${issue.severity}`}></div>
                  <span className="detected-issue-text">
                    {issue.title} in {issue.file}:{issue.line}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="progress-stats">
            <div className="progress-stat">
              <span className="progress-stat-label">Files scanned</span>
              <span className="progress-stat-value">
                {sessionStatus?.analyzedFiles ?? Math.floor(progress * 1.95)}
              </span>
            </div>
            <div className="progress-stat">
              <span className="progress-stat-label">Issues found</span>
              <span className="progress-stat-value issues">{issues.length}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Decorative shapes component
function DecoShapes() {
  return (
    <>
      {/* Top left shapes */}
      <div style={{
        position: 'absolute',
        top: '10%',
        left: '5%',
        width: '120px',
        height: '120px',
        background: '#dcfce7',
        borderRadius: '24px',
        border: '3px solid #a7f3d0',
        transform: 'rotate(-12deg)',
        animation: 'float 6s ease-in-out infinite',
      }}>
        <div style={{
          position: 'absolute',
          top: '30%',
          left: '25%',
          width: '12px',
          height: '12px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
        <div style={{
          position: 'absolute',
          top: '30%',
          right: '25%',
          width: '12px',
          height: '12px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
        <div style={{
          position: 'absolute',
          bottom: '30%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '24px',
          height: '12px',
          borderBottom: '3px solid #1a1a1a',
          borderRadius: '0 0 12px 12px',
        }} />
      </div>

      {/* Top right shape */}
      <div style={{
        position: 'absolute',
        top: '15%',
        right: '8%',
        width: '80px',
        height: '100px',
        background: '#fef9c3',
        borderRadius: '16px',
        border: '3px solid #fde047',
        transform: 'rotate(8deg)',
        animation: 'float 5s ease-in-out infinite 0.5s',
      }}>
        <div style={{
          position: 'absolute',
          top: '35%',
          left: '25%',
          width: '8px',
          height: '8px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
        <div style={{
          position: 'absolute',
          top: '35%',
          right: '25%',
          width: '8px',
          height: '8px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
      </div>

      {/* Bottom left shape */}
      <div style={{
        position: 'absolute',
        bottom: '15%',
        left: '8%',
        width: '100px',
        height: '80px',
        background: '#dbeafe',
        borderRadius: '16px',
        border: '3px solid #93c5fd',
        transform: 'rotate(6deg)',
        animation: 'float 7s ease-in-out infinite 1s',
      }}>
        <div style={{
          position: 'absolute',
          top: '35%',
          left: '28%',
          width: '10px',
          height: '10px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
        <div style={{
          position: 'absolute',
          top: '35%',
          right: '28%',
          width: '10px',
          height: '10px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
      </div>

      {/* Bottom right shape */}
      <div style={{
        position: 'absolute',
        bottom: '20%',
        right: '12%',
        width: '90px',
        height: '110px',
        background: '#fce7f3',
        borderRadius: '20px',
        border: '3px solid #f9a8d4',
        transform: 'rotate(-6deg)',
        animation: 'float 6s ease-in-out infinite 1.5s',
      }}>
        <div style={{
          position: 'absolute',
          top: '30%',
          left: '28%',
          width: '10px',
          height: '10px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
        <div style={{
          position: 'absolute',
          top: '30%',
          right: '28%',
          width: '10px',
          height: '10px',
          background: '#1a1a1a',
          borderRadius: '50%',
        }} />
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '20px',
          height: '10px',
          border: '3px solid #1a1a1a',
          borderTop: 'none',
          borderRadius: '0 0 10px 10px',
        }} />
      </div>

      {/* Small accent shapes */}
      <div style={{
        position: 'absolute',
        top: '40%',
        left: '15%',
        width: '40px',
        height: '40px',
        background: '#ffedd5',
        borderRadius: '12px',
        border: '3px solid #fed7aa',
        transform: 'rotate(15deg)',
        animation: 'float 4s ease-in-out infinite 0.8s',
      }} />

      <div style={{
        position: 'absolute',
        top: '50%',
        right: '10%',
        width: '50px',
        height: '50px',
        background: '#f3e8ff',
        borderRadius: '50%',
        border: '3px solid #d8b4fe',
        animation: 'float 5s ease-in-out infinite 1.2s',
      }} />
    </>
  );
}

function App() {
  const [repoUrl, setRepoUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedLines, setSelectedLines] = useState<number[]>([]);
  const [selectedDiagram, setSelectedDiagram] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('current');
  const [selectedFileContent, setSelectedFileContent] = useState<string>('');
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [fixPromptOpen, setFixPromptOpen] = useState(false);
  const [isGeneratingFix, setIsGeneratingFix] = useState(false);
  const [isApplyingFix, setIsApplyingFix] = useState(false);
  const [isVerifyingFix, setIsVerifyingFix] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{ kind: 'idle' | 'ok' | 'warn' | 'error'; message: string } | null>(null);
  const [patchReviewOpen, setPatchReviewOpen] = useState(false);
  const [patchReviewPatchSetId, setPatchReviewPatchSetId] = useState<string | null>(null);
  const [patchReviewPatches, setPatchReviewPatches] = useState<Patch[]>([]);
  const [patchReviewSelectedFiles, setPatchReviewSelectedFiles] = useState<Record<string, boolean>>({});
  const [patchReviewActiveFile, setPatchReviewActiveFile] = useState<string | null>(null);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  const [findingDiagramOpen, setFindingDiagramOpen] = useState(false);
  const [findingDiagram, setFindingDiagram] = useState<Diagram | null>(null);
  const [findingDiagramTitle, setFindingDiagramTitle] = useState('Finding Diagram');
  const [findingDiagramFindingId, setFindingDiagramFindingId] = useState<string | null>(null);
  const [findingDiagramError, setFindingDiagramError] = useState<string | null>(null);
  const [isFindingDiagramLoading, setIsFindingDiagramLoading] = useState(false);

  const { analyze, resume, upsertPatch, upsertDiagram, updateAnalysis, updateFileTree, sessionId, isLoading, progress, statusMessage, sessionStatus, result, error } = useAnalysis();
  const activeSessionId = result?.sessionId || sessionId;

  const errorSummary = useMemo(() => {
    if (!error) return '';
    const lines = error.split('\n').map(l => l.trim()).filter(Boolean);
    return lines[0] || error;
  }, [error]);

  const errorHasDetails = Boolean(error && error.includes('\n'));

  const errorHint = useMemo(() => {
    if (!error) return null;
    const lower = error.toLowerCase();

    const looksLikeGitHubNetwork =
      lower.includes('github.com') &&
      (lower.includes('failed to connect') ||
        lower.includes("couldn't connect") ||
        lower.includes('connect timeout') ||
        lower.includes('unable to access') ||
        lower.includes('could not resolve host'));

    if (looksLikeGitHubNetwork) {
      return 'GitHub appears unreachable from this machine. Tip: download the repo locally (ZIP → unzip) and paste the folder path (e.g., /Users/you/project) into the input.';
    }

    const looksLikeOpenAITimeout =
      lower.includes('api connection timeout') ||
      lower.includes('request timed out') ||
      lower.includes('und_err_connect_timeout');

    if (looksLikeOpenAITimeout) {
      return 'Network timeout reaching the AI service. Check your internet/VPN and retry. You can still restore previous sessions from “Sessions”.';
    }

    return null;
  }, [error]);

  const handleAnalyze = () => {
    if (repoUrl.trim()) {
      setSelectedFile(null);
      setSelectedLines([]);
      setSelectedDiagram(null);
      setFixPromptOpen(false);
      setShowErrorDetails(false);
      analyze(repoUrl.trim());
    }
  };

  const handleSelectFile = (path: string) => {
    setSelectedFile(path);
    setSelectedLines([]);
    setSelectedDiagram(null);
    setFixPromptOpen(false);
    setViewMode('current');
    setVerifyStatus(null);
  };

  const handleSelectFinding = (selection: { file: string; lines: number[] }) => {
    setSelectedFile(selection.file);
    setSelectedLines(selection.lines);
    setSelectedDiagram(null);
    setFixPromptOpen(false);
    setViewMode('current');
    setVerifyStatus(null);
  };

  const handleSelectDiagram = (name: string) => {
    setSelectedDiagram(name);
    setSelectedFile(null);
    setSelectedLines([]);
    setFixPromptOpen(false);
    setViewMode('current');
    setVerifyStatus(null);
  };

  const selectedPatch: Patch | undefined = selectedFile
    ? result?.patches?.find(p => p.file === selectedFile)
    : undefined;
  const selectedFileLanguage = selectedFile ? getLanguageFromPath(selectedFile) : 'plaintext';

  const hasPatches = (result?.patches?.length || 0) > 0;
  const selectedDiagramObj = selectedDiagram ? result?.diagrams?.find(d => d.name === selectedDiagram) : undefined;

  const selectedPatchSetPendingCount = useMemo(() => {
    if (!result || !selectedPatch?.patchSetId) return 0;
    return (result.patches || []).filter(p => p.patchSetId === selectedPatch.patchSetId && !p.appliedAt).length;
  }, [result, selectedPatch?.patchSetId]);

  const handleDiagramUpdated = (diagram: Diagram) => {
    upsertDiagram(diagram);
    setFindingDiagram(prev => (prev?.name === diagram.name ? diagram : prev));
  };

  const viewFindingDiagram = async (findingId: string) => {
    if (!activeSessionId || !result) return;

    const finding = result.analysis.allFindings.find(f => f.id === findingId);
    setFindingDiagramTitle(finding?.title ? `Finding Flow: ${finding.title}` : 'Finding Diagram');
    setFindingDiagramFindingId(findingId);
    setFindingDiagramError(null);
    setFindingDiagramOpen(true);

    const existing = result.diagrams.find(d => d.findingId === findingId);
    if (existing) {
      setFindingDiagram(existing);
      return;
    }

    setFindingDiagram(null);
    setIsFindingDiagramLoading(true);
    try {
      const response = await fetch(`/api/sessions/${activeSessionId}/diagrams/finding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to generate diagram');

      const diagram = data.diagram as Diagram;
      upsertDiagram(diagram);
      setFindingDiagram(diagram);
    } catch (e) {
      setFindingDiagramError(e instanceof Error ? e.message : 'Failed to generate diagram');
    } finally {
      setIsFindingDiagramLoading(false);
    }
  };

  // Load selected file content from backend (stored repo clone)
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!selectedFile || !activeSessionId) {
        setSelectedFileContent('');
        return;
      }

      setIsFileLoading(true);
      try {
        const response = await fetch(`/api/sessions/${activeSessionId}/file?path=${encodeURIComponent(selectedFile)}`);
        const data = await response.json();
        if (!cancelled) {
          setSelectedFileContent(data.content || '');
        }
      } catch {
        if (!cancelled) setSelectedFileContent('');
      } finally {
        if (!cancelled) setIsFileLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, selectedFile]);

  const fileHasFindings = selectedFile
    ? (result?.analysis?.allFindings || []).some(f => f.file === selectedFile)
    : false;

  const openPatchReview = (patchSetId: string, patches: Patch[], focusFile?: string) => {
    if (!patchSetId || patches.length === 0) return;

    setPatchReviewPatchSetId(patchSetId);
    setPatchReviewPatches(patches);

    const selection: Record<string, boolean> = {};
    for (const p of patches) {
      const action = p.action || 'modify';
      selection[p.file] = Boolean(!p.appliedAt && action !== 'add');
    }

    // If everything defaulted to false (e.g. only "add" ops), select the focused file if present.
    if (Object.values(selection).every(v => !v)) {
      const preferred = focusFile && selection[focusFile] !== undefined ? focusFile : patches[0]?.file;
      if (preferred) selection[preferred] = true;
    }

    setPatchReviewSelectedFiles(selection);
    setPatchReviewActiveFile(
      (focusFile && patches.some(p => p.file === focusFile)) ? focusFile : patches[0]?.file || null
    );
    setPatchReviewOpen(true);
  };

  const reviewSelectedFix = () => {
    if (!result || !selectedPatch?.patchSetId) return;
    const patches = (result.patches || []).filter(p => p.patchSetId === selectedPatch.patchSetId);
    if (patches.length === 0) return;
    openPatchReview(selectedPatch.patchSetId, patches, selectedFile || patches[0]?.file);
  };

  const generateFix = async () => {
    if (!activeSessionId || !selectedFile) return;
    setIsGeneratingFix(true);
    try {
      const response = await fetch(`/api/sessions/${activeSessionId}/patchset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selectedFile }),
      });
      const data = await response.json();
      if (!response.ok) {
        const extra = Array.isArray(data.details) ? `\n\n${data.details.join('\n')}` : '';
        throw new Error((data.error || 'Failed to generate fix plan') + extra);
      }

      const patchSetId = String(data.patchSetId || '');
      const patches = Array.isArray(data.patches) ? (data.patches as Patch[]) : [];
      if (!patchSetId || patches.length === 0) throw new Error('Fix plan returned no changes');

      patches.forEach(upsertPatch);
      setFixPromptOpen(false);
      setViewMode('diff');
      openPatchReview(patchSetId, patches, selectedFile);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to generate fix plan');
    } finally {
      setIsGeneratingFix(false);
    }
  };

  const applySelectedFixes = async () => {
    if (!activeSessionId || !patchReviewPatchSetId) return;
    setIsApplyingFix(true);
    setVerifyStatus(null);
    let verifyPath: string | null = null;
    try {
      const selected = Object.entries(patchReviewSelectedFiles)
        .filter(([, checked]) => checked)
        .map(([file]) => file);

      const filesToApply = patchReviewPatches
        .filter(p => selected.includes(p.file) && !p.appliedAt)
        .map(p => p.file);

      if (filesToApply.length === 0) {
        throw new Error('No selected changes to apply');
      }

      if (selectedFile && filesToApply.includes(selectedFile)) {
        verifyPath = selectedFile;
      } else if (patchReviewActiveFile && filesToApply.includes(patchReviewActiveFile)) {
        verifyPath = patchReviewActiveFile;
      }

      const response = await fetch(`/api/sessions/${activeSessionId}/patchset/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patchSetId: patchReviewPatchSetId, files: filesToApply }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to apply fix plan');

      const appliedPatches = Array.isArray(data.patches) ? (data.patches as Patch[]) : [];
      appliedPatches.forEach(upsertPatch);

      if (Array.isArray(data.fileTree)) {
        updateFileTree(data.fileTree);
      }

      const activeFile = selectedFile || patchReviewActiveFile;
      if (activeFile) {
        const patchForActive = appliedPatches.find(p => p.file === activeFile);
        if (patchForActive?.patchedContent) setSelectedFileContent(patchForActive.patchedContent);
      }

      setViewMode('current');
      setPatchReviewOpen(false);
      setPatchReviewPatchSetId(null);
      setPatchReviewPatches([]);
      setPatchReviewSelectedFiles({});
      setPatchReviewActiveFile(null);

      if (verifyPath) {
        await verifyFile(verifyPath);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to apply fix plan');
    } finally {
      setIsApplyingFix(false);
    }
  };

  const applyLegacyFix = async () => {
    if (!activeSessionId || !selectedFile) return;
    if (!selectedPatch || selectedPatch.appliedAt || selectedPatch.patchSetId) return;
    setIsApplyingFix(true);
    setVerifyStatus(null);
    try {
      const response = await fetch(`/api/sessions/${activeSessionId}/patch/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selectedFile }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to apply patch');

      upsertPatch(data.patch as Patch);
      if (data.patch?.patchedContent) setSelectedFileContent(data.patch.patchedContent);
      setViewMode('current');
      await verifyFile(selectedFile);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to apply patch');
    } finally {
      setIsApplyingFix(false);
    }
  };

  const verifyFile = async (filePath: string) => {
    if (!activeSessionId) return;
    setIsVerifyingFix(true);
    try {
      const verifyResponse = await fetch(`/api/sessions/${activeSessionId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath }),
      });
      const verifyData = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(verifyData.error || 'Verification failed');
      if (verifyData.analysis) updateAnalysis(verifyData.analysis);
      const remaining = Array.isArray(verifyData.findings) ? verifyData.findings.length : null;
      if (remaining === 0) {
        setVerifyStatus({ kind: 'ok', message: 'Verified: no findings remain in this file.' });
      } else if (typeof remaining === 'number') {
        setVerifyStatus({ kind: 'warn', message: `Fix applied, but ${remaining} finding${remaining === 1 ? '' : 's'} still detected.` });
      } else {
        setVerifyStatus({ kind: 'ok', message: 'Fix applied and verified.' });
      }
    } catch (e) {
      setVerifyStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Verification failed' });
    } finally {
      setIsVerifyingFix(false);
    }
  };

  const patchReviewActivePatch = useMemo(() => {
    if (patchReviewPatches.length === 0) return null;
    if (patchReviewActiveFile) {
      return patchReviewPatches.find(p => p.file === patchReviewActiveFile) || patchReviewPatches[0] || null;
    }
    return patchReviewPatches[0] || null;
  }, [patchReviewActiveFile, patchReviewPatches]);

  const patchReviewSelectedCount = useMemo(() => {
    const selected = new Set(
      Object.entries(patchReviewSelectedFiles)
        .filter(([, checked]) => checked)
        .map(([file]) => file)
    );
    return patchReviewPatches.filter(p => selected.has(p.file) && !p.appliedAt).length;
  }, [patchReviewPatches, patchReviewSelectedFiles]);

  return (
    <div className="app">
      <Header
        repoUrl={repoUrl}
        onRepoUrlChange={setRepoUrl}
        onAnalyze={handleAnalyze}
        onOpenSessions={() => setSessionsDialogOpen(true)}
        isLoading={isLoading}
        hasResults={!!result}
      />

      {isLoading && (
        <SkeletonLoader progress={progress} statusMessage={statusMessage} sessionId={sessionId} sessionStatus={sessionStatus} />
      )}

      {error && (
        <div className="error-banner">
          <div className="error-banner-row">
            <span>
              <strong>Error:</strong> {errorSummary}
            </span>
            {errorHasDetails && (
              <button
                className="error-banner-toggle"
                type="button"
                onClick={() => setShowErrorDetails(v => !v)}
                aria-expanded={showErrorDetails}
              >
                {showErrorDetails ? 'Hide details' : 'Details'}
              </button>
            )}
          </div>
          {errorHint && (
            <div className="error-banner-hint">{errorHint}</div>
          )}
          {errorHasDetails && showErrorDetails && (
            <pre className="error-banner-details">{error}</pre>
          )}
        </div>
      )}

      {result && (
        <div className="main-layout">
          <aside className="sidebar">
            <FileBrowser
              files={result.fileTree || []}
              findings={result.analysis?.allFindings || []}
              patches={result.patches || []}
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
            />

            <DiagramsBrowser
              diagrams={result.diagrams || []}
              selectedDiagram={selectedDiagram}
              onSelectDiagram={handleSelectDiagram}
            />

            <div className="summary-stats">
              <h4>Summary</h4>
              <div className="stat-grid">
                <div className="stat critical">
                  <span className="stat-value">{result.analysis?.findingsBySeverity?.critical?.length || 0}</span>
                  <span className="stat-label">Critical</span>
                </div>
                <div className="stat high">
                  <span className="stat-value">{result.analysis?.findingsBySeverity?.high?.length || 0}</span>
                  <span className="stat-label">High</span>
                </div>
                <div className="stat medium">
                  <span className="stat-value">{result.analysis?.findingsBySeverity?.medium?.length || 0}</span>
                  <span className="stat-label">Medium</span>
                </div>
                <div className="stat low">
                  <span className="stat-value">{result.analysis?.findingsBySeverity?.low?.length || 0}</span>
                  <span className="stat-label">Low</span>
                </div>
              </div>
              {hasPatches && (
                <p className="patches-count">
                  {result.patches.length} patch{result.patches.length !== 1 ? 'es' : ''} generated
                </p>
              )}
            </div>
          </aside>

          <main className="content">
            {selectedDiagramObj ? (
              <>
                <div className="editor-header">
                  <span className="file-path">{selectedDiagramObj.title}</span>
                </div>
                <div className="editor-container">
                  <MermaidViewer
                    diagram={selectedDiagramObj}
                    sessionId={activeSessionId}
                    onDiagramUpdated={handleDiagramUpdated}
                  />
                </div>
              </>
            ) : selectedFile ? (
              <>
                <div className="editor-header">
                  <span className="file-path">{selectedFile}</span>
                  <div className="editor-actions">
                    {fileHasFindings && (!selectedPatch || !!selectedPatch.appliedAt) && !fixPromptOpen && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={isFileLoading || isGeneratingFix}
                        onClick={() => setFixPromptOpen(true)}
                        title="Generate a suggested fix plan (review before applying)"
                      >
                        <Wrench size={14} />
                        {selectedPatch?.appliedAt ? 'Generate Next Fix' : 'Generate Fix'}
                      </button>
                    )}

                    {fixPromptOpen && (
                      <div className="fix-prompt">
                        <span className="fix-prompt-text">Generate an AI fix plan? (may touch multiple files)</span>
                        <button className="btn btn-secondary btn-sm" onClick={() => setFixPromptOpen(false)} disabled={isGeneratingFix}>
                          Cancel
                        </button>
                        <button className="btn btn-primary btn-sm" onClick={generateFix} disabled={isGeneratingFix}>
                          {isGeneratingFix ? 'Generating…' : 'Generate'}
                        </button>
                      </div>
                    )}

                    {selectedPatch?.patchSetId && selectedPatchSetPendingCount > 0 && (
                      <button className="btn btn-primary btn-sm" onClick={reviewSelectedFix} disabled={isApplyingFix}>
                        Review & Apply{selectedPatchSetPendingCount > 1 ? ` (${selectedPatchSetPendingCount})` : ''}
                      </button>
                    )}

                    {selectedPatch && !selectedPatch.appliedAt && !selectedPatch.patchSetId && (
                      <button className="btn btn-primary btn-sm" onClick={applyLegacyFix} disabled={isApplyingFix}>
                        {isApplyingFix ? 'Applying…' : 'Apply Fix'}
                      </button>
                    )}

                    {selectedPatch?.appliedAt && isVerifyingFix && (
                      <div className="verify-pill verifying" title="Re-analyzing this file to refresh findings">
                        <span className="spinner spinner-dark" />
                        Verifying…
                      </div>
                    )}

                    {selectedPatch?.appliedAt && !isVerifyingFix && verifyStatus && (
                      <div className={`verify-pill ${verifyStatus.kind}`} title={verifyStatus.message}>
                        {verifyStatus.message}
                      </div>
                    )}

                    {selectedPatch && (
                      <ToggleGroup.Root
                        className="toggle-group"
                        type="single"
                        value={viewMode}
                        onValueChange={(value) => value && setViewMode(value as ViewMode)}
                      >
                        <ToggleGroup.Item className="toggle-item" value="current">
                          <Eye size={14} />
                          Current
                        </ToggleGroup.Item>
                        {selectedPatch.appliedAt && (
                          <ToggleGroup.Item className="toggle-item" value="original">
                            <History size={14} />
                            Original
                          </ToggleGroup.Item>
                        )}
                        <ToggleGroup.Item className="toggle-item" value="diff">
                          <GitCompare size={14} />
                          Diff
                        </ToggleGroup.Item>
                      </ToggleGroup.Root>
                    )}
                  </div>
                </div>
                <div className="editor-container">
                  {viewMode !== 'diff' || !selectedPatch ? (
                    <CodeEditor
                      value={viewMode === 'original' && selectedPatch ? selectedPatch.originalContent : selectedFileContent}
                      language={selectedFileLanguage}
                      highlightLines={selectedLines}
                      readOnly
                    />
                  ) : (
                    <DiffViewer
                      original={selectedPatch.originalContent}
                      modified={selectedPatch.patchedContent}
                      language={selectedFileLanguage}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="empty-editor">
                <h3>Select a file or diagram to view</h3>
                <p>Files with findings are marked with a warning icon</p>
              </div>
            )}
          </main>

          <aside className="findings-sidebar">
            <FindingsPanel
              findings={result.analysis?.allFindings || []}
              patches={result.patches || []}
              selectedFile={selectedFile}
              onSelectFinding={handleSelectFinding}
              onViewDiagram={viewFindingDiagram}
            />
          </aside>
        </div>
      )}

      <Dialog.Root
        open={patchReviewOpen}
        onOpenChange={(open) => {
          setPatchReviewOpen(open);
          if (!open) {
            setPatchReviewPatchSetId(null);
            setPatchReviewPatches([]);
            setPatchReviewSelectedFiles({});
            setPatchReviewActiveFile(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content patch-review-dialog">
            <div className="dialog-header">
              <Dialog.Title className="dialog-title">Fix Plan</Dialog.Title>
              <Dialog.Close className="dialog-close" aria-label="Close">
                <X size={16} />
              </Dialog.Close>
            </div>

            <div className="dialog-body patch-review-body">
              {patchReviewPatches.length === 0 ? (
                <div className="dialog-loading">
                  <span className="spinner" />
                  Preparing…
                </div>
              ) : (
                <>
                  <div className="patch-review-layout">
                    <div className="patch-review-list">
                      <div className="patch-review-list-header">
                        <span>Files</span>
                        <span className="patch-review-count">{patchReviewPatches.length}</span>
                      </div>
                      <div className="patch-review-list-scroll">
                        {patchReviewPatches.map((p) => {
                          const isActive = patchReviewActiveFile === p.file;
                          const isSelected = Boolean(patchReviewSelectedFiles[p.file]);
                          const action = p.action || 'modify';
                          const isApplied = Boolean(p.appliedAt);
                          return (
                            <div
                              key={p.file}
                              className={`patch-review-item ${isActive ? 'active' : ''}`}
                              onClick={() => setPatchReviewActiveFile(p.file)}
                              title={p.file}
                            >
                              <label className={`patch-review-check ${isApplied ? 'disabled' : ''}`} onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isApplied ? true : isSelected}
                                  disabled={isApplied}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setPatchReviewSelectedFiles(prev => ({ ...prev, [p.file]: checked }));
                                  }}
                                />
                                <span className="patch-review-checkmark" />
                              </label>
                              <div className="patch-review-item-main">
                                <span className="patch-review-path">{p.file}</span>
                                <div className="patch-review-badges">
                                  <span className={`patch-review-badge ${action}`}>{action === 'add' ? 'Add' : 'Modify'}</span>
                                  {isApplied && <span className="patch-review-badge applied">Applied</span>}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="patch-review-diff">
                      {patchReviewActivePatch ? (
                        <DiffViewer
                          original={patchReviewActivePatch.originalContent || ''}
                          modified={patchReviewActivePatch.patchedContent || ''}
                          language={getLanguageFromPath(patchReviewActivePatch.file)}
                        />
                      ) : (
                        <div className="dialog-loading">No changes</div>
                      )}
                    </div>
                  </div>

                  <div className="patch-review-footer">
                    <div className="patch-review-summary">
                      <strong>{patchReviewSelectedCount}</strong> selected to apply
                    </div>
                    <div className="patch-review-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => setPatchReviewOpen(false)} disabled={isApplyingFix}>
                        Cancel
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={applySelectedFixes} disabled={isApplyingFix || patchReviewSelectedCount === 0}>
                        {isApplyingFix ? 'Applying…' : 'Apply Selected'}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={findingDiagramOpen}
        onOpenChange={(open) => {
          setFindingDiagramOpen(open);
      if (!open) {
        setFindingDiagram(null);
        setFindingDiagramError(null);
        setIsFindingDiagramLoading(false);
        setFindingDiagramFindingId(null);
      }
    }}
  >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content diagram-dialog">
            <div className="dialog-header">
              <Dialog.Title className="dialog-title">{findingDiagramTitle}</Dialog.Title>
              <Dialog.Close className="dialog-close" aria-label="Close">
                <X size={16} />
              </Dialog.Close>
            </div>

            <div className="dialog-body">
              {findingDiagramError && (
                <div className="dialog-error">
                  <strong>Error:</strong> {findingDiagramError}
                  {findingDiagramFindingId && !isFindingDiagramLoading && (
                    <div style={{ marginTop: 12 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => viewFindingDiagram(findingDiagramFindingId)}>
                        Retry
                      </button>
                    </div>
                  )}
                </div>
              )}

              {isFindingDiagramLoading && (
                <div className="dialog-loading">
                  <span className="spinner" />
                  Generating diagram…
                </div>
              )}

              {!isFindingDiagramLoading && findingDiagram && (
                <MermaidViewer
                  diagram={findingDiagram}
                  sessionId={activeSessionId}
                  onDiagramUpdated={handleDiagramUpdated}
                />
              )}

              {!isFindingDiagramLoading && !findingDiagram && !findingDiagramError && (
                <div className="dialog-loading">
                  <span className="spinner" />
                  Preparing…
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <SessionsDialog
        open={sessionsDialogOpen}
        onOpenChange={setSessionsDialogOpen}
        currentSessionId={activeSessionId || null}
        onResumeSession={resume}
      />

      {!result && !isLoading && (
        <div className="welcome-screen">
          <DecoShapes />
          <div className="welcome-content">
            <img
              src="https://cdn.prod.website-files.com/66acb95cb4494fc16ceefb5c/66acbab0f2243846b02e7c79_Logo.svg"
              alt="Logo"
              className="welcome-logo"
            />
            <div style={{
              display: 'inline-flex',
              padding: '0.5rem 1rem',
              background: '#f3e8ff',
              borderRadius: '100px',
              marginBottom: '1.5rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#7c3aed',
              border: '2px solid #e9d5ff'
            }}>
              AI-Powered Security Analysis
            </div>
            <h2>Make your healthcare apps<br />HIPAA compliant</h2>
            <p style={{ maxWidth: '400px', margin: '0 auto 2.5rem' }}>
              Scan a GitHub repository or local project folder for security vulnerabilities and get AI-generated fixes instantly
            </p>
            <div className="feature-list">
              <div className="feature">
                <span className="feature-icon">
                  <Shield size={20} />
                </span>
                <div>
                  <strong>Scan & Snapshot</strong>
                  <p>We snapshot the project into a session so you can restore results later</p>
                </div>
              </div>
              <div className="feature">
                <span className="feature-icon">
                  <Search size={20} />
                </span>
                <div>
                  <strong>Detect Issues</strong>
                  <p>AI identifies PHI exposure, encryption gaps, and security risks</p>
                </div>
              </div>
              <div className="feature">
                <span className="feature-icon">
                  <Wrench size={20} />
                </span>
                <div>
                  <strong>Generate Fixes</strong>
                  <p>Get AI-generated patches ready to apply for each issue</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
