import * as Tooltip from '@radix-ui/react-tooltip';
import { Code, Folder, Github, History, Plus, Shield } from 'lucide-react';

const LOGO_URL = 'https://cdn.prod.website-files.com/66acb95cb4494fc16ceefb5c/66acbab0f2243846b02e7c79_Logo.svg';

interface HeaderProps {
  repoUrl: string;
  onRepoUrlChange: (url: string) => void;
  onAnalyze: () => void;
  onNewScan?: () => void;
  onOpenSessions: () => void;
  onOpenGitHub: () => void;
  githubEnabled: boolean;
  githubConnectedLabel?: string | null;
  isLoading: boolean;
  hasResults: boolean;
  view?: 'security' | 'workspace';
  onViewChange?: (view: 'security' | 'workspace') => void;
}

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

export function Header({
  repoUrl,
  onRepoUrlChange,
  onAnalyze,
  onNewScan,
  onOpenSessions,
  onOpenGitHub,
  githubEnabled,
  githubConnectedLabel,
  isLoading,
  hasResults,
  view,
  onViewChange,
}: HeaderProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAnalyze();
  };

  const isLocal = isLikelyLocalRepoInput(repoUrl);
  const showNewScan = Boolean(onNewScan) && (hasResults || Boolean(repoUrl.trim()));

  return (
    <Tooltip.Provider>
      <header className="app-header">
        <div className="header-brand">
          <img src={LOGO_URL} alt="Logo" className="brand-logo" />
        </div>

        <form className="repo-input" onSubmit={handleSubmit}>
          <div className="input-wrapper">
            {isLocal ? (
              <Folder size={16} className="input-icon" />
            ) : (
              <Github size={16} className="input-icon" />
            )}
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => onRepoUrlChange(e.target.value)}
              placeholder="github.com/owner/repo, owner/repo, or /path/to/folder"
              title="Paste a GitHub repo (owner/repo) or a local folder path (e.g., /Users/you/project)"
              disabled={isLoading}
            />
          </div>

          {hasResults && view && onViewChange && (
            <div className="view-toggle" role="group" aria-label="View selector">
              <button
                type="button"
                className={`btn btn-secondary btn-sm ${view === 'security' ? 'active' : ''}`}
                onClick={() => onViewChange('security')}
                disabled={isLoading}
                title="Security Center"
              >
                <Shield size={16} />
                Security
              </button>
              <button
                type="button"
                className={`btn btn-secondary btn-sm ${view === 'workspace' ? 'active' : ''}`}
                onClick={() => onViewChange('workspace')}
                disabled={isLoading}
                title="Workspace"
              >
                <Code size={16} />
                Workspace
              </button>
            </div>
          )}

          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onOpenSessions}
                disabled={isLoading}
              >
                <History size={16} />
                Sessions
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip-content" sideOffset={5}>
                Restore a previous scan
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>

          {showNewScan && (
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onNewScan}
                  disabled={isLoading}
                >
                  <Plus size={16} />
                  New scan
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" sideOffset={5}>
                  Clear the current session and start over
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          )}

          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onOpenGitHub}
                disabled={isLoading || !githubEnabled}
              >
                <Github size={16} />
                GitHub
                {githubConnectedLabel ? (
                  <span className="github-pill" title={`Connected as ${githubConnectedLabel}`}>
                    {githubConnectedLabel}
                  </span>
                ) : null}
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip-content" sideOffset={5}>
                {githubEnabled ? (githubConnectedLabel ? 'Pick a private repo or create PRs' : 'Connect GitHub to scan private repos') : 'GitHub App not configured'}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>

          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button type="submit" className="btn btn-primary" disabled={isLoading || !repoUrl.trim()}>
                {isLoading ? (
                  <>
                    <span className="spinner" />
                    Analyzing
                  </>
                ) : (
                  'Analyze'
                )}
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip-content" sideOffset={5}>
                Scan repository for HIPAA compliance issues
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </form>
      </header>
    </Tooltip.Provider>
  );
}
