import Editor, { DiffEditor } from '@monaco-editor/react';

interface CodeEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (value: string | undefined) => void;
}

export function CodeEditor({ value, language = 'typescript', readOnly = true, onChange }: CodeEditorProps) {
  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="light"
      onChange={onChange}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace",
        wordWrap: 'on',
        lineNumbers: 'on',
        tabSize: 2,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: 'line',
        lineHeight: 20,
        letterSpacing: 0,
        cursorBlinking: 'smooth',
        smoothScrolling: true,
        contextmenu: false,
        folding: true,
        foldingHighlight: false,
        guides: {
          indentation: true,
          bracketPairs: false,
        },
      }}
    />
  );
}

interface DiffViewerProps {
  original: string;
  modified: string;
  language?: string;
}

export function DiffViewer({ original, modified, language = 'typescript' }: DiffViewerProps) {
  return (
    <DiffEditor
      height="100%"
      language={language}
      original={original}
      modified={modified}
      theme="light"
      options={{
        readOnly: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderSideBySide: true,
        smoothScrolling: true,
      }}
    />
  );
}

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'go': 'go',
    'rb': 'ruby',
    'php': 'php',
    'sql': 'sql',
    'json': 'json',
    'yml': 'yaml',
    'yaml': 'yaml',
    'md': 'markdown',
    'html': 'html',
    'css': 'css',
    'env': 'plaintext',
  };
  return languageMap[ext || ''] || 'plaintext';
}
