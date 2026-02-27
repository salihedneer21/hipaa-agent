import { useState } from 'react';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import * as Collapsible from '@radix-ui/react-collapsible';
import { FileCode, Folder, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  issueCount?: number;
  hasPatch?: boolean;
}

interface FileBrowserProps {
  files: string[];
  findings: { file: string }[];
  patches: { file: string }[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

function buildFileTree(files: string[]): FileNode[] {
  const root: FileNode[] = [];

  for (const filePath of files) {
    const parts = filePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let node = current.find(n => n.name === part);

      if (!node) {
        node = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'folder',
          children: isFile ? undefined : [],
        };
        current.push(node);
      }

      if (!isFile && node.children) {
        current = node.children;
      }
    }
  }

  const sortNodes = (nodes: FileNode[]): FileNode[] => {
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    }).map(node => ({
      ...node,
      children: node.children ? sortNodes(node.children) : undefined,
    }));
  };

  return sortNodes(root);
}

function FileTreeNode({
  node,
  findings,
  patches,
  selectedFile,
  onSelectFile,
  depth = 0,
}: {
  node: FileNode;
  findings: { file: string }[];
  patches: { file: string }[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  depth?: number;
}) {
  const [isOpen, setIsOpen] = useState(depth < 2);

  const issueCount = findings.filter(f => f.file === node.path).length;
  const hasPatch = patches.some(p => p.file === node.path);
  const isSelected = selectedFile === node.path;

  if (node.type === 'folder') {
    const folderIssues = findings.filter(f => f.file.startsWith(node.path + '/')).length;

    return (
      <Collapsible.Root open={isOpen} onOpenChange={setIsOpen}>
        <Collapsible.Trigger asChild>
          <div
            className="file-tree-item folder"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Folder size={14} className="file-icon folder-icon" />
            <span className="file-name">{node.name}</span>
            {folderIssues > 0 && (
              <span className="issue-badge">{folderIssues}</span>
            )}
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          {node.children?.map(child => (
            <FileTreeNode
              key={child.path}
              node={child}
              findings={findings}
              patches={patches}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              depth={depth + 1}
            />
          ))}
        </Collapsible.Content>
      </Collapsible.Root>
    );
  }

  return (
    <div
      className={`file-tree-item file ${isSelected ? 'selected' : ''} ${issueCount > 0 ? 'has-issues' : ''}`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={() => onSelectFile(node.path)}
    >
      <FileCode size={14} className="file-icon" />
      <span className="file-name">{node.name}</span>
      {issueCount > 0 && (
        <AlertTriangle size={12} className="issue-icon" />
      )}
      {hasPatch && (
        <span className="patch-badge">Fixed</span>
      )}
    </div>
  );
}

export function FileBrowser({ files, findings, patches, selectedFile, onSelectFile }: FileBrowserProps) {
  const tree = buildFileTree(files);

  return (
    <div className="file-browser">
      <div className="file-browser-header">
        <Folder size={14} />
        <span>Files</span>
        <span className="file-count">{files.length}</span>
      </div>
      <ScrollArea.Root className="scroll-area-root">
        <ScrollArea.Viewport className="scroll-area-viewport">
          <div className="file-tree">
            {tree.map(node => (
              <FileTreeNode
                key={node.path}
                node={node}
                findings={findings}
                patches={patches}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="scroll-area-scrollbar" orientation="vertical">
          <ScrollArea.Thumb className="scroll-area-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
