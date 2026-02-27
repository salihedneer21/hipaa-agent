import { useState } from 'react';
import * as Progress from '@radix-ui/react-progress';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { Header } from './components/Header';
import { FileBrowser } from './components/FileBrowser';
import { CodeEditor, DiffViewer, getLanguageFromPath } from './components/CodeEditor';
import { FindingsPanel } from './components/FindingsPanel';
import { useAnalysis } from './hooks/useAnalysis';
import { Loader2, Eye, GitCompare, Shield, Search, Wrench } from 'lucide-react';

type ViewMode = 'code' | 'diff';

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
  const [viewMode, setViewMode] = useState<ViewMode>('code');

  const { analyze, isLoading, progress, statusMessage, result, error } = useAnalysis();

  const handleAnalyze = () => {
    if (repoUrl.trim()) {
      setSelectedFile(null);
      analyze(repoUrl.trim(), true);
    }
  };

  const handleSelectFile = (path: string) => {
    setSelectedFile(path);
    setViewMode('code');
  };

  const handleSelectFinding = (finding: { file: string; line: number }) => {
    setSelectedFile(finding.file);
  };

  const getFileContent = (path: string): string => {
    if (!result?.files) return '';
    const file = result.files.find(f => f.path === path);
    return file?.content || '';
  };

  const getPatchedContent = (path: string): string | null => {
    if (!result?.patches?.patches) return null;
    const patch = result.patches.patches.find(p => p.file === path);
    return patch?.patchedContent || null;
  };

  const selectedFileContent = selectedFile ? getFileContent(selectedFile) : '';
  const selectedFilePatch = selectedFile ? getPatchedContent(selectedFile) : null;
  const selectedFileLanguage = selectedFile ? getLanguageFromPath(selectedFile) : 'plaintext';

  const hasPatches = result?.patches?.patchesGenerated && result.patches.patchesGenerated > 0;

  return (
    <div className="app">
      <Header
        repoUrl={repoUrl}
        onRepoUrlChange={setRepoUrl}
        onAnalyze={handleAnalyze}
        isLoading={isLoading}
        hasResults={!!result}
      />

      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-content">
            <Loader2 size={40} className="spinner-icon" />
            <div className="loading-progress">
              <Progress.Root className="progress-root" value={progress}>
                <Progress.Indicator
                  className="progress-indicator"
                  style={{ transform: `translateX(-${100 - progress}%)` }}
                />
              </Progress.Root>
              <p>{statusMessage}</p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {result && (
        <div className="main-layout">
          <aside className="sidebar">
            <FileBrowser
              files={result.files?.map(f => f.path) || []}
              findings={result.analysis?.allFindings || []}
              patches={result.patches?.patches || []}
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
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
                  {result.patches?.patchesGenerated} files patched
                </p>
              )}
            </div>
          </aside>

          <main className="content">
            {selectedFile ? (
              <>
                <div className="editor-header">
                  <span className="file-path">{selectedFile}</span>
                  {selectedFilePatch && (
                    <ToggleGroup.Root
                      className="toggle-group"
                      type="single"
                      value={viewMode}
                      onValueChange={(value) => value && setViewMode(value as ViewMode)}
                    >
                      <ToggleGroup.Item className="toggle-item" value="code">
                        <Eye size={14} />
                        Original
                      </ToggleGroup.Item>
                      <ToggleGroup.Item className="toggle-item" value="diff">
                        <GitCompare size={14} />
                        Diff
                      </ToggleGroup.Item>
                    </ToggleGroup.Root>
                  )}
                </div>
                <div className="editor-container">
                  {viewMode === 'code' || !selectedFilePatch ? (
                    <CodeEditor
                      value={selectedFileContent}
                      language={selectedFileLanguage}
                      readOnly
                    />
                  ) : (
                    <DiffViewer
                      original={selectedFileContent}
                      modified={selectedFilePatch}
                      language={selectedFileLanguage}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="empty-editor">
                <h3>Select a file to view</h3>
                <p>Files with issues are marked with a warning icon</p>
              </div>
            )}
          </main>

          <aside className="findings-sidebar">
            <FindingsPanel
              findings={result.analysis?.allFindings || []}
              selectedFile={selectedFile}
              onSelectFinding={handleSelectFinding}
            />
          </aside>
        </div>
      )}

      {!result && !isLoading && (
        <div className="welcome-screen">
          <DecoShapes />
          <div className="welcome-content">
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
              Scan your GitHub repository for security vulnerabilities and get AI-generated fixes instantly
            </p>
            <div className="feature-list">
              <div className="feature">
                <span className="feature-icon">
                  <Shield size={20} />
                </span>
                <div>
                  <strong>Clone & Scan</strong>
                  <p>We analyze every file in your repository for HIPAA violations</p>
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
