import * as Tooltip from '@radix-ui/react-tooltip';
import { Shield, Github } from 'lucide-react';

interface HeaderProps {
  repoUrl: string;
  onRepoUrlChange: (url: string) => void;
  onAnalyze: () => void;
  isLoading: boolean;
  hasResults: boolean;
}

export function Header({
  repoUrl,
  onRepoUrlChange,
  onAnalyze,
  isLoading,
}: HeaderProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAnalyze();
  };

  return (
    <Tooltip.Provider>
      <header className="app-header">
        <div className="header-brand">
          <Shield size={24} className="brand-icon" />
          <div>
            <h1>HIPAA Compliance Agent</h1>
            <p>AI-powered security analysis</p>
          </div>
        </div>

        <form className="repo-input" onSubmit={handleSubmit}>
          <div className="input-wrapper">
            <Github size={16} className="input-icon" />
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => onRepoUrlChange(e.target.value)}
              placeholder="github.com/owner/repo or owner/repo"
              disabled={isLoading}
            />
          </div>
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
