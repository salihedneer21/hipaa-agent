import * as Tooltip from '@radix-ui/react-tooltip';
import { Folder, Github, History } from 'lucide-react';

const LOGO_URL = 'https://cdn.prod.website-files.com/66acb95cb4494fc16ceefb5c/66acbab0f2243846b02e7c79_Logo.svg';

interface HeaderProps {
  repoUrl: string;
  onRepoUrlChange: (url: string) => void;
  onAnalyze: () => void;
  onOpenSessions: () => void;
  onOpenGitHub: () => void;
  githubEnabled: boolean;
  githubConnectedLabel?: string | null;
  isLoading: boolean;
  hasResults: boolean;
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
  onOpenSessions,
  onOpenGitHub,
  githubEnabled,
  githubConnectedLabel,
  isLoading,
}: HeaderProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAnalyze();
  };

  const isLocal = isLikelyLocalRepoInput(repoUrl);

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
