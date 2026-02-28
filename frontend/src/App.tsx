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
import { apiFetch } from './api';

type ViewMode = 'current' | 'original' | 'diff';
type PreviewIssue = NonNullable<SessionStatus['issuesPreview']>[number];

type GitHubInstallation = {
  installationId: number;
  accountLogin?: string;
  accountType?: 'User' | 'Organization';
  repositorySelection?: 'all' | 'selected';
};

type GitHubRepoItem = {
  id: number;
  fullName: string;
  name: string;
  owner?: string;
  private: boolean;
  defaultBranch?: string;
};

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

      apiFetch(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(wanted)}&maxBytes=8000`, { signal: controller.signal })
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
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [githubInstallations, setGithubInstallations] = useState<GitHubInstallation[]>([]);
  const [selectedGithubInstallationId, setSelectedGithubInstallationId] = useState<number | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepoItem[]>([]);
  const [githubRepoSearch, setGithubRepoSearch] = useState('');
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubCallbackInstallationId, setGithubCallbackInstallationId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedLines, setSelectedLines] = useState<number[]>([]);
  const [selectedDiagram, setSelectedDiagram] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('current');
  const [selectedFileContent, setSelectedFileContent] = useState<string>('');
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [fixPromptOpen, setFixPromptOpen] = useState(false);
  const [fixTargetFindingId, setFixTargetFindingId] = useState<string | null>(null);
  const [isGeneratingFix, setIsGeneratingFix] = useState(false);
  const [isApplyingFix, setIsApplyingFix] = useState(false);
  const [isVerifyingFix, setIsVerifyingFix] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{ kind: 'idle' | 'ok' | 'warn' | 'error'; message: string } | null>(null);
  const [patchReviewOpen, setPatchReviewOpen] = useState(false);
  const [patchReviewPatchSetId, setPatchReviewPatchSetId] = useState<string | null>(null);
  const [patchReviewPatches, setPatchReviewPatches] = useState<Patch[]>([]);
  const [patchReviewSelectedFiles, setPatchReviewSelectedFiles] = useState<Record<string, boolean>>({});
  const [patchReviewActiveFile, setPatchReviewActiveFile] = useState<string | null>(null);
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [isCreatingPr, setIsCreatingPr] = useState(false);
  const [createdPr, setCreatedPr] = useState<{ number: number; html_url: string; branch?: string; base?: string } | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  const [findingDiagramOpen, setFindingDiagramOpen] = useState(false);
  const [findingDiagram, setFindingDiagram] = useState<Diagram | null>(null);
  const [findingDiagramTitle, setFindingDiagramTitle] = useState('Finding Diagram');
  const [findingDiagramFindingId, setFindingDiagramFindingId] = useState<string | null>(null);
  const [findingDiagramError, setFindingDiagramError] = useState<string | null>(null);
  const [isFindingDiagramLoading, setIsFindingDiagramLoading] = useState(false);

  const { analyze, resume, upsertPatch, upsertDiagram, updateAnalysis, updateFileTree, updateResolvedFindings, sessionId, isLoading, progress, statusMessage, sessionStatus, result, error } = useAnalysis();
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

  const githubConnectedLabel = useMemo(() => {
    if (githubInstallations.length === 0) return null;
    const selected = selectedGithubInstallationId
      ? githubInstallations.find(i => i.installationId === selectedGithubInstallationId)
      : githubInstallations[0];
    return selected?.accountLogin || 'Connected';
  }, [githubInstallations, selectedGithubInstallationId]);

  function isLikelyLocalRepoInput(value: string): boolean {
    const raw = (value || '').trim();
    if (!raw) return false;
    if (raw.startsWith('file:')) return true;
    if (raw === '~' || raw.startsWith('~/')) return true;
    if (raw.startsWith('./') || raw.startsWith('../')) return true;
    if (raw.startsWith('/')) return true;
    if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
    return false;
  }

  const refreshGitHubConfig = async () => {
    try {
      const response = await apiFetch('/api/github/config');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load GitHub config');
      setGithubConfigured(Boolean(data.configured));
    } catch {
      setGithubConfigured(false);
    }
  };

  const refreshGitHubInstallations = async () => {
    try {
      const response = await apiFetch('/api/github/installations');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load GitHub installations');
      const installations: GitHubInstallation[] = Array.isArray(data.installations)
        ? data.installations.map((i: any) => ({
          installationId: Number(i.installationId),
          accountLogin: typeof i.accountLogin === 'string' ? i.accountLogin : undefined,
          accountType: (i.accountType === 'Organization' || i.accountType === 'User') ? i.accountType : undefined,
          repositorySelection: (i.repositorySelection === 'all' || i.repositorySelection === 'selected') ? i.repositorySelection : undefined,
        })).filter((i: GitHubInstallation) => Number.isFinite(i.installationId) && i.installationId > 0)
        : [];
      setGithubInstallations(installations);
      if (!selectedGithubInstallationId && installations.length > 0) {
        setSelectedGithubInstallationId(installations[0]!.installationId);
      }
    } catch (e) {
      setGithubInstallations([]);
    }
  };

  const refreshGitHubRepos = async (installationId: number) => {
    if (!installationId) return;
    setGithubLoading(true);
    setGithubError(null);
    try {
      const response = await apiFetch(`/api/github/repos?installationId=${encodeURIComponent(String(installationId))}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load repositories');
      const repos: GitHubRepoItem[] = Array.isArray(data.repos)
        ? data.repos.map((r: any) => ({
          id: Number(r.id),
          fullName: String(r.fullName || ''),
          name: String(r.name || ''),
          owner: typeof r.owner === 'string' ? r.owner : undefined,
          private: Boolean(r.private),
          defaultBranch: typeof r.defaultBranch === 'string' ? r.defaultBranch : undefined,
        })).filter((r: GitHubRepoItem) => Number.isFinite(r.id) && r.id > 0 && Boolean(r.fullName))
        : [];
      setGithubRepos(repos);
    } catch (e) {
      setGithubRepos([]);
      setGithubError(e instanceof Error ? e.message : 'Failed to load repositories');
    } finally {
      setGithubLoading(false);
    }
  };

  const connectGitHub = async () => {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const redirect = `${window.location.pathname}${window.location.search || ''}`;
      const response = await apiFetch(`/api/github/install-url?redirect=${encodeURIComponent(redirect)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to start GitHub connect');
      if (!data.url) throw new Error('Missing GitHub install URL');
      window.location.href = String(data.url);
    } catch (e) {
      setGithubError(e instanceof Error ? e.message : 'Failed to connect GitHub');
      setGithubLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const iidRaw = params.get('github_installation_id');
    if (iidRaw) {
      const iid = Number(iidRaw);
      if (Number.isFinite(iid) && iid > 0) setGithubCallbackInstallationId(iid);
      params.delete('github_installation_id');
      const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash || ''}`;
      window.history.replaceState({}, '', next);
      setGithubDialogOpen(true);
    }
  }, []);

  useEffect(() => {
    refreshGitHubConfig();
    refreshGitHubInstallations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!githubDialogOpen) return;
    if (!selectedGithubInstallationId) return;
    refreshGitHubRepos(selectedGithubInstallationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubDialogOpen, selectedGithubInstallationId]);

  useEffect(() => {
    if (!githubCallbackInstallationId) return;
    const exists = githubInstallations.some(i => i.installationId === githubCallbackInstallationId);
    if (exists) setSelectedGithubInstallationId(githubCallbackInstallationId);
  }, [githubCallbackInstallationId, githubInstallations]);

  const handleAnalyze = () => {
    if (repoUrl.trim()) {
      setSelectedFile(null);
      setSelectedLines([]);
      setSelectedDiagram(null);
      setFixPromptOpen(false);
      setFixTargetFindingId(null);
      setShowErrorDetails(false);
      analyze(repoUrl.trim(), {
        githubInstallationId: isLikelyLocalRepoInput(repoUrl) ? null : selectedGithubInstallationId,
      });
    }
  };

  const handleSelectFile = (path: string) => {
    setSelectedFile(path);
    setSelectedLines([]);
    setSelectedDiagram(null);
    setFixPromptOpen(false);
    setFixTargetFindingId(null);
    setViewMode('current');
    setVerifyStatus(null);
  };

  const handleSelectFinding = (selection: { file: string; lines: number[] }) => {
    setSelectedFile(selection.file);
    setSelectedLines(selection.lines);
    setSelectedDiagram(null);
    setFixPromptOpen(false);
    setFixTargetFindingId(null);
    setViewMode('current');
    setVerifyStatus(null);
  };

  const handleSelectDiagram = (name: string) => {
    setSelectedDiagram(name);
    setSelectedFile(null);
    setSelectedLines([]);
    setFixPromptOpen(false);
    setFixTargetFindingId(null);
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
      const response = await apiFetch(`/api/sessions/${activeSessionId}/diagrams/finding`, {
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
        const response = await apiFetch(`/api/sessions/${activeSessionId}/file?path=${encodeURIComponent(selectedFile)}`);
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
      selection[p.file] = Boolean(!p.appliedAt);
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
      const payload: Record<string, unknown> = { file: selectedFile };
      if (fixTargetFindingId) payload.findingId = fixTargetFindingId;

      const response = await apiFetch(`/api/sessions/${activeSessionId}/patchset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
      setFixTargetFindingId(null);
      setViewMode('diff');
      openPatchReview(patchSetId, patches, selectedFile);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to generate fix plan');
    } finally {
      setIsGeneratingFix(false);
    }
  };

  const handleFixFinding = (findingId: string) => {
    if (!result) return;
    const finding = result.analysis.allFindings.find(f => f.id === findingId);
    if (!finding) return;

    const lines = Array.from(new Set((finding.locations || []).map(l => l.line).filter(n => Number.isFinite(n) && n > 0))).sort((a, b) => a - b);
    setSelectedFile(finding.file);
    setSelectedLines(lines);
    setSelectedDiagram(null);
    setViewMode('current');
    setVerifyStatus(null);

    setFixTargetFindingId(findingId);
    setFixPromptOpen(true);
  };

  const applySelectedFixes = async () => {
    if (!activeSessionId || !patchReviewPatchSetId) return;
    setIsApplyingFix(true);
    setVerifyStatus(null);
    const filesWithFindingsBefore = new Set((result?.analysis?.allFindings || []).map(f => f.file));
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

      const response = await apiFetch(`/api/sessions/${activeSessionId}/patchset/apply`, {
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

      setViewMode('diff');
      setPatchReviewOpen(false);
      setPatchReviewPatchSetId(null);
      setPatchReviewPatches([]);
      setPatchReviewSelectedFiles({});
      setPatchReviewActiveFile(null);

      const filesToVerify = Array.from(new Set(filesToApply.filter(f => filesWithFindingsBefore.has(f))));
      if (filesToVerify.length > 0) {
        await verifyFiles(filesToVerify);
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
      const response = await apiFetch(`/api/sessions/${activeSessionId}/patch/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selectedFile }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to apply patch');

      upsertPatch(data.patch as Patch);
      if (data.patch?.patchedContent) setSelectedFileContent(data.patch.patchedContent);
      setViewMode('diff');
      await verifyFiles([selectedFile]);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to apply patch');
    } finally {
      setIsApplyingFix(false);
    }
  };

  const revertFix = async () => {
    if (!activeSessionId || !selectedFile) return;
    if (!selectedPatch?.appliedAt) return;

    const ok = window.confirm(`Revert applied fix for ${selectedFile}? This will restore the previous content in the session snapshot.`);
    if (!ok) return;

    setIsApplyingFix(true);
    setVerifyStatus(null);
    try {
      const response = await apiFetch(`/api/sessions/${activeSessionId}/patch/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selectedFile }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to revert patch');

      if (data.patch) upsertPatch(data.patch as Patch);
      if (Array.isArray(data.fileTree)) updateFileTree(data.fileTree);

      if (selectedPatch.action === 'add') {
        // File no longer exists.
        setSelectedFile(null);
        setSelectedFileContent('');
      } else {
        setSelectedFileContent((data.patch?.originalContent as string) || '');
        setViewMode('current');
        await verifyFiles([selectedFile]);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to revert patch');
    } finally {
      setIsApplyingFix(false);
    }
  };

  const verifyFiles = async (filePaths: string[]) => {
    if (!activeSessionId) return;
    const unique = Array.from(new Set((filePaths || []).map(p => (p || '').trim()).filter(Boolean)));
    if (unique.length === 0) return;

    setIsVerifyingFix(true);
    try {
      let verified = 0;
      let remainingTotal = 0;
      const errors: string[] = [];

      for (const filePath of unique) {
        try {
          const verifyResponse = await apiFetch(`/api/sessions/${activeSessionId}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: filePath }),
          });
          const verifyData = await verifyResponse.json();
          if (!verifyResponse.ok) throw new Error(verifyData.error || 'Verification failed');
          if (verifyData.analysis) updateAnalysis(verifyData.analysis);
          if (Array.isArray(verifyData.resolvedFindings)) updateResolvedFindings(verifyData.resolvedFindings);
          const remaining = Array.isArray(verifyData.findings) ? verifyData.findings.length : 0;
          remainingTotal += remaining;
          verified++;
        } catch (e) {
          errors.push(`${filePath}: ${e instanceof Error ? e.message : 'Verification failed'}`);
        }
      }

      if (errors.length > 0) {
        const first = errors[0] || 'Verification failed';
        setVerifyStatus({
          kind: 'error',
          message: errors.length === 1 ? first : `Verification failed for ${errors.length}/${unique.length} file(s). First: ${first}`,
        });
        return;
      }

      if (remainingTotal === 0) {
        setVerifyStatus({ kind: 'ok', message: verified === 1 ? 'Verified: no findings remain in this file.' : `Verified ${verified} files: no findings remain.` });
      } else {
        setVerifyStatus({ kind: 'warn', message: verified === 1 ? `Fix applied, but ${remainingTotal} finding${remainingTotal === 1 ? '' : 's'} still detected.` : `Verified ${verified} files: ${remainingTotal} finding${remainingTotal === 1 ? '' : 's'} still detected.` });
      }
    } finally {
      setIsVerifyingFix(false);
    }
  };

  const hasAppliedPatches = useMemo(() => {
    return (result?.patches || []).some(p => Boolean(p.appliedAt));
  }, [result?.patches]);

  const sessionRepoFullName = useMemo(() => {
    if (result?.github?.repoFullName) return result.github.repoFullName;
    const normalized = result?.normalizedRepoUrl || '';
    try {
      const u = new URL(normalized);
      if (u.hostname !== 'github.com') return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const owner = parts[0]!;
      const repo = parts[1]!.replace(/\.git$/i, '');
      if (!owner || !repo) return null;
      return `${owner}/${repo}`;
    } catch {
      return null;
    }
  }, [result?.github?.repoFullName, result?.normalizedRepoUrl]);

  const prInstallationId = useMemo(() => {
    const fromSession = result?.github?.installationId;
    if (typeof fromSession === 'number' && Number.isFinite(fromSession) && fromSession > 0) return fromSession;
    if (typeof selectedGithubInstallationId === 'number' && Number.isFinite(selectedGithubInstallationId) && selectedGithubInstallationId > 0) return selectedGithubInstallationId;
    return null;
  }, [result?.github?.installationId, selectedGithubInstallationId]);

  const canCreatePr = useMemo(() => {
    if (!activeSessionId) return false;
    if (!githubConfigured) return false;
    if (!hasAppliedPatches) return false;
    if (!sessionRepoFullName) return false;
    if (!prInstallationId) return false;
    return true;
  }, [activeSessionId, githubConfigured, hasAppliedPatches, prInstallationId, sessionRepoFullName]);

  const buildDefaultPrBody = () => {
    const applied = (result?.patches || []).filter(p => Boolean(p.appliedAt));
    const resolvedCount = Array.isArray(result?.resolvedFindings) ? result!.resolvedFindings!.length : 0;
    const lines: string[] = [];
    lines.push('## Summary');
    lines.push('');
    lines.push(`- Applied patches: ${applied.length}`);
    if (resolvedCount) lines.push(`- Resolved findings (verified): ${resolvedCount}`);
    lines.push('');
    lines.push('## Changes');
    lines.push('');
    for (const p of applied.slice(0, 30)) {
      lines.push(`- ${p.file}${p.explanation ? ` — ${p.explanation}` : ''}`);
    }
    if (applied.length > 30) lines.push(`- …and ${applied.length - 30} more`);
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    lines.push('- Please run the project build/tests before merging.');
    lines.push('- Generated by HIPAA Agent.');
    lines.push('');
    return lines.join('\n');
  };

  const openCreatePrDialog = () => {
    setCreatedPr(null);
    setPrError(null);
    const defaultTitle = sessionRepoFullName ? `HIPAA Agent: fixes for ${sessionRepoFullName}` : 'HIPAA Agent: security fixes';
    setPrTitle((t) => t || defaultTitle);
    setPrBody((b) => b || buildDefaultPrBody());
    setPrDialogOpen(true);
  };

  const createPullRequest = async () => {
    if (!activeSessionId) return;
    if (!sessionRepoFullName) return;
    if (!prInstallationId) return;
    setIsCreatingPr(true);
    setPrError(null);
    setCreatedPr(null);
    try {
      const response = await apiFetch(`/api/sessions/${activeSessionId}/github/pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: prTitle,
          body: prBody,
          installationId: prInstallationId,
          repoFullName: sessionRepoFullName,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to create PR');
      if (data?.pr?.html_url) {
        setCreatedPr({
          number: Number(data.pr.number),
          html_url: String(data.pr.html_url),
          branch: typeof data.branch === 'string' ? data.branch : undefined,
          base: typeof data.base === 'string' ? data.base : undefined,
        });
      } else {
        throw new Error('PR created, but response was missing pr.html_url');
      }
    } catch (e) {
      setPrError(e instanceof Error ? e.message : 'Failed to create PR');
    } finally {
      setIsCreatingPr(false);
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

  const patchReviewUnselectedAdds = useMemo(() => {
    const selected = patchReviewSelectedFiles;
    return patchReviewPatches
      .filter(p => (p.action || 'modify') === 'add' && !p.appliedAt)
      .filter(p => !selected[p.file])
      .map(p => p.file);
  }, [patchReviewPatches, patchReviewSelectedFiles]);

  return (
    <div className="app">
      <Header
        repoUrl={repoUrl}
        onRepoUrlChange={setRepoUrl}
        onAnalyze={handleAnalyze}
        onOpenSessions={() => setSessionsDialogOpen(true)}
        onOpenGitHub={() => setGithubDialogOpen(true)}
        githubEnabled={githubConfigured}
        githubConnectedLabel={githubConnectedLabel}
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
              <div className="summary-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={openCreatePrDialog}
                  disabled={!canCreatePr}
                  title={canCreatePr ? 'Create a PR with the applied fixes' : 'Connect GitHub and apply at least one fix to enable PR creation'}
                >
                  Create PR
                </button>
              </div>
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
                    {fileHasFindings && !fixPromptOpen && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={isFileLoading || isGeneratingFix}
                        onClick={() => {
                          setFixTargetFindingId(null);
                          setFixPromptOpen(true);
                        }}
                        title="Generate a suggested fix plan (review before applying)"
                      >
                        <Wrench size={14} />
                        {selectedPatch?.appliedAt ? 'Generate Next Fix' : selectedPatch ? 'Regenerate Fix' : 'Generate Fix'}
                      </button>
                    )}

                    {fixPromptOpen && (
                      <div className="fix-prompt">
                        <span className="fix-prompt-text">
                          {fixTargetFindingId
                            ? 'Generate an AI fix plan for this finding? (may touch multiple files)'
                            : 'Generate an AI fix plan for this file? (may touch multiple files)'}
                          {selectedPatch && !selectedPatch.appliedAt ? ' This replaces the previous plan.' : ''}
                        </span>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setFixPromptOpen(false);
                            setFixTargetFindingId(null);
                          }}
                          disabled={isGeneratingFix}
                        >
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

                    {selectedPatch?.appliedAt && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={revertFix}
                        disabled={isApplyingFix || isVerifyingFix}
                        title="Revert this file back to its pre-fix content (session snapshot only)"
                      >
                        Revert
                      </button>
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
                        <ToggleGroup.Item className="toggle-item" value="original">
                          <History size={14} />
                          Original
                        </ToggleGroup.Item>
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
              resolvedFindings={result.resolvedFindings || []}
              selectedFile={selectedFile}
              onSelectFinding={handleSelectFinding}
              onFixFinding={handleFixFinding}
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
                      {patchReviewUnselectedAdds.length > 0 && (
                        <div className="patch-review-warning">
                          Warning: you unselected {patchReviewUnselectedAdds.length} new file{patchReviewUnselectedAdds.length === 1 ? '' : 's'}. This may break imports or runtime behavior.
                        </div>
                      )}
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

      <Dialog.Root
        open={githubDialogOpen}
        onOpenChange={(open) => {
          setGithubDialogOpen(open);
          if (open) {
            setGithubError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content github-dialog">
            <div className="dialog-header">
              <Dialog.Title className="dialog-title">GitHub</Dialog.Title>
              <Dialog.Close className="dialog-close" aria-label="Close">
                <X size={16} />
              </Dialog.Close>
            </div>

            <div className="dialog-body github-body">
              {!githubConfigured ? (
                <div className="dialog-error">
                  <strong>GitHub App is not configured.</strong>
                  <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                    Set <code>GITHUB_APP_SLUG</code>, <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code> (or <code>GITHUB_APP_PRIVATE_KEY_PATH</code>),
                    and <code>HIPAA_AGENT_FRONTEND_URL</code> on the backend.
                  </div>
                </div>
              ) : githubInstallations.length === 0 ? (
                <div className="github-empty">
                  <div className="github-empty-title">Connect GitHub to scan private repos and create PRs.</div>
                  {githubError && (
                    <div className="dialog-error" style={{ marginTop: 12 }}>
                      <strong>Error:</strong> {githubError}
                    </div>
                  )}
                  <div style={{ marginTop: 14 }}>
                    <button className="btn btn-primary" type="button" onClick={connectGitHub} disabled={githubLoading}>
                      {githubLoading ? (
                        <>
                          <span className="spinner" />
                          Redirecting…
                        </>
                      ) : (
                        'Connect GitHub'
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="github-controls">
                    <label className="github-select">
                      <span>Installation</span>
                      <select
                        value={selectedGithubInstallationId || githubInstallations[0]?.installationId || ''}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n > 0) setSelectedGithubInstallationId(n);
                        }}
                        disabled={githubLoading}
                      >
                        {githubInstallations.map((i) => (
                          <option key={i.installationId} value={i.installationId}>
                            {i.accountLogin ? `${i.accountLogin}${i.accountType ? ` (${i.accountType})` : ''}` : `Installation ${i.installationId}`}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="github-controls-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => selectedGithubInstallationId && refreshGitHubRepos(selectedGithubInstallationId)}
                        disabled={githubLoading || !selectedGithubInstallationId}
                      >
                        Refresh
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={connectGitHub}
                        disabled={githubLoading}
                        title="Install the GitHub App on another account or organization"
                      >
                        Add org/account
                      </button>
                    </div>
                  </div>

                  <div className="github-search">
                    <Search size={16} className="github-search-icon" />
                    <input
                      type="text"
                      value={githubRepoSearch}
                      onChange={(e) => setGithubRepoSearch(e.target.value)}
                      placeholder="Search repos…"
                      disabled={githubLoading}
                    />
                  </div>

                  {githubError && (
                    <div className="dialog-error" style={{ marginBottom: 12 }}>
                      <strong>Error:</strong> {githubError}
                    </div>
                  )}

                  {githubLoading ? (
                    <div className="dialog-loading">
                      <span className="spinner" />
                      Loading repositories…
                    </div>
                  ) : (
                    <div className="github-repo-list">
                      {githubRepos
                        .filter(r => {
                          const q = githubRepoSearch.trim().toLowerCase();
                          if (!q) return true;
                          return r.fullName.toLowerCase().includes(q);
                        })
                        .slice(0, 400)
                        .map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            className="github-repo-item"
                            onClick={() => {
                              setRepoUrl(r.fullName);
                              setGithubDialogOpen(false);
                            }}
                            title={r.fullName}
                          >
                            <span className="github-repo-name">{r.fullName}</span>
                            {r.private && <span className="github-repo-badge private">Private</span>}
                          </button>
                        ))}
                      {githubRepos.length === 0 && (
                        <div className="github-repo-empty">No repositories found for this installation.</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={prDialogOpen}
        onOpenChange={(open) => {
          setPrDialogOpen(open);
          if (!open) {
            setPrError(null);
            setCreatedPr(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content pr-dialog">
            <div className="dialog-header">
              <Dialog.Title className="dialog-title">Create Pull Request</Dialog.Title>
              <Dialog.Close className="dialog-close" aria-label="Close">
                <X size={16} />
              </Dialog.Close>
            </div>

            <div className="dialog-body pr-body">
              {!canCreatePr ? (
                <div className="dialog-error">
                  <strong>PR creation isn’t available yet.</strong>
                  <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 13 }}>
                    Connect GitHub, analyze a GitHub repo, and apply at least one fix.
                  </div>
                </div>
              ) : (
                <>
                  {prError && (
                    <div className="dialog-error">
                      <strong>Error:</strong> {prError}
                    </div>
                  )}

                  {createdPr && (
                    <div className="pr-success">
                      <strong>PR created:</strong>{' '}
                      <a href={createdPr.html_url} target="_blank" rel="noreferrer">
                        #{createdPr.number}
                      </a>
                      {createdPr.branch && <span className="pr-meta">Branch: {createdPr.branch}</span>}
                      {createdPr.base && <span className="pr-meta">Base: {createdPr.base}</span>}
                    </div>
                  )}

                  <div className="pr-field">
                    <label>Title</label>
                    <input
                      type="text"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      placeholder="PR title"
                      disabled={isCreatingPr}
                    />
                  </div>

                  <div className="pr-field">
                    <label>Body</label>
                    <textarea
                      value={prBody}
                      onChange={(e) => setPrBody(e.target.value)}
                      rows={10}
                      placeholder="Describe the changes…"
                      disabled={isCreatingPr}
                    />
                  </div>

                  <div className="pr-actions">
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => setPrDialogOpen(false)} disabled={isCreatingPr}>
                      Close
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      onClick={createPullRequest}
                      disabled={isCreatingPr || !prTitle.trim()}
                      title="Creates a branch, commits the applied session changes, pushes, and opens a PR"
                    >
                      {isCreatingPr ? (
                        <>
                          <span className="spinner" />
                          Creating…
                        </>
                      ) : (
                        'Create PR'
                      )}
                    </button>
                  </div>
                </>
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
