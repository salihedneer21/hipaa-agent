import { useRef, useEffect } from 'react';
import Editor, { DiffEditor, type Monaco } from '@monaco-editor/react';

interface CodeEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  highlightLines?: number[];
  onChange?: (value: string | undefined) => void;
}

export function CodeEditor({ value, language = 'typescript', readOnly = true, highlightLines, onChange }: CodeEditorProps) {
  const editorRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);

  const handleEditorMount = (editorInstance: any, _monaco: Monaco) => {
    editorRef.current = editorInstance;
  };

  // Scroll to and highlight lines when selection changes (or when file content changes).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const uniqueInOrder: number[] = [];
    const seen = new Set<number>();
    for (const n of highlightLines || []) {
      const lineNumber = Number(n);
      if (!Number.isFinite(lineNumber) || lineNumber <= 0) continue;
      if (seen.has(lineNumber)) continue;
      seen.add(lineNumber);
      uniqueInOrder.push(lineNumber);
    }
    const decorationLines = [...uniqueInOrder].sort((a, b) => a - b);

    if (uniqueInOrder.length === 0) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }

    const focusLine = uniqueInOrder[0]!;
    editor.revealLineInCenter(focusLine);
    editor.setPosition({ lineNumber: focusLine, column: 1 });

    decorationsRef.current = editor.deltaDecorations(
      decorationsRef.current,
      decorationLines.map(lineNumber => ({
        range: {
          startLineNumber: lineNumber,
          startColumn: 1,
          endLineNumber: lineNumber,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: 'highlighted-line',
          glyphMarginClassName: 'highlighted-line-glyph',
        },
      }))
    );
  }, [highlightLines, value]);

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="light"
      onChange={onChange}
      onMount={handleEditorMount}
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
        glyphMargin: true,
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
