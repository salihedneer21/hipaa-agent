/**
 * Analysis Routes
 * API endpoints for HIPAA compliance analysis
 */

import { Router, type Request, type Response } from 'express';
import type { Router as ExpressRouter } from 'express';
import path from 'path';
import { GitHubService } from '../services/githubService.js';
import { AnalyzerAgent } from '../agents/analyzerAgent.js';
import { PatcherAgent } from '../agents/patcherAgent.js';
import { diagramAgent } from '../agents/diagramAgent.js';
import { diagramFixAgent } from '../agents/diagramFixAgent.js';
import { patchSetAgent } from '../agents/patchSetAgent.js';
import logger from '../utils/logger.js';
import { sessionStore } from '../services/sessionStore.js';
import type { StoredDiagram, StoredPatch } from '../services/sessionStore.js';
import { getSessionRepoDir } from '../utils/storagePaths.js';
import { ANALYZABLE_EXTENSIONS, SKIP_DIRECTORIES } from '../knowledge/hipaaRules.js';

const router: ExpressRouter = Router();

interface AnalyzeRequest {
  repoUrl: string;
}

type IssuePreview = {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  title: string;
};

// Store analysis sessions
const sessions = new Map<string, {
  status: 'pending' | 'analyzing' | 'patching' | 'complete' | 'error';
  progress: number;
  message: string;
  createdAt: string;
  repoUrl?: string;
  normalizedRepoUrl?: string;
  commitHash?: string;
  fileTree?: string[];
  totalFiles?: number;
  analyzedFiles?: number;
  currentFile?: string;
  issuesPreview?: IssuePreview[];
  result?: any;
  error?: string;
}>();

/**
 * POST /api/analyze
 * Start analysis of a GitHub repository (public repos - no token needed)
 */
router.post('/analyze', async (req: Request, res: Response) => {
  const { repoUrl }: AnalyzeRequest = req.body;

  if (!repoUrl) {
    res.status(400).json({ error: 'repoUrl is required' });
    return;
  }

  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Initialize session
  sessions.set(sessionId, {
    status: 'pending',
    progress: 0,
    message: 'Starting analysis...',
    createdAt: new Date().toISOString(),
  });

  // Return session ID immediately
  res.json({ sessionId, message: 'Analysis started' });

  // Run analysis in background
  runAnalysis(sessionId, repoUrl);
});

async function runAnalysis(sessionId: string, repoUrl: string) {
  const session = sessions.get(sessionId)!;
  const service = new GitHubService();

  try {
    logger.info({ sessionId, repoUrl }, 'Starting analysis');

    // Step 1: Clone repository
    session.status = 'analyzing';
    session.progress = 5;
    session.message = 'Cloning repository...';

    const repoData = await service.fetchRepoForAnalysis(sessionId, repoUrl);
    logger.info({ sessionId, fileCount: repoData.fileTree.length }, 'Repository cloned');

    session.repoUrl = repoUrl;
    session.normalizedRepoUrl = repoData.normalizedRepoUrl;
    session.commitHash = repoData.commitHash;
    session.fileTree = repoData.fileTree;
    session.totalFiles = repoData.fileTree.length;
    session.analyzedFiles = 0;
    session.issuesPreview = [];

    session.progress = 15;
    session.message = `Found ${repoData.fileTree.length} files to analyze...`;

    // Step 2: Analyze files
    logger.info({ sessionId }, 'Starting file analysis');
    const analyzer = new AnalyzerAgent();
    const allFindings = [];
    let analyzedFiles = 0;
    const totalFiles = repoData.fileTree.length;

    for (let i = 0; i < repoData.fileTree.length; i++) {
      const filePath = repoData.fileTree[i]!;
      try {
        session.currentFile = filePath;
        session.message = `Analyzing ${i + 1}/${totalFiles}: ${filePath}`;
        session.progress = 15 + Math.round(((i + 1) / totalFiles) * 70);

        const content = await service.readFile(repoData.repoPath, filePath);
        if (!content) continue;

        const findings = await analyzer.analyzeFile(filePath, content);
        allFindings.push(...findings);
        if (session.issuesPreview) {
          for (const finding of findings) {
            if (session.issuesPreview.length >= 6) break;
            if (session.issuesPreview.some(p => p.id === finding.id)) continue;
            session.issuesPreview.push({
              id: finding.id,
              severity: finding.severity,
              file: finding.file,
              line: finding.locations?.[0]?.line || 1,
              title: finding.title,
            });
          }
        }
        analyzedFiles++;
        session.analyzedFiles = analyzedFiles;
      } catch (error) {
        logger.error({ err: error, file: filePath, sessionId }, 'File analysis failed');
        analyzedFiles++;
        session.analyzedFiles = analyzedFiles;
      }
    }

    const analysisResult = analyzer.buildAnalysisResult(totalFiles, analyzedFiles, allFindings);
    logger.info({ sessionId, findings: analysisResult.totalFindings }, 'Analysis complete');

    session.progress = 90;
    session.message = `Found ${analysisResult.totalFindings} issues. Generating diagrams...`;

    // Step 3: Generate Mermaid diagrams (best-effort)
    const topFindings = [
      ...analysisResult.findingsBySeverity.critical,
      ...analysisResult.findingsBySeverity.high,
      ...analysisResult.findingsBySeverity.medium,
      ...analysisResult.findingsBySeverity.low,
    ].slice(0, 12);

    const findingsSummary = topFindings
      .map(f => `- [${f.severity}] ${f.file}:${f.locations?.[0]?.line || '?'} ${f.title} — ${f.issue}`)
      .join('\n');

    const keyFilePaths = new Set<string>();
    for (const f of topFindings) keyFilePaths.add(f.file);

    const entrypointHints = repoData.fileTree.filter(p => /(index|main|app|server)\.(ts|tsx|js|jsx|py|go|java)$/i.test(p)).slice(0, 4);
    entrypointHints.forEach(p => keyFilePaths.add(p));

    const packageFiles = repoData.fileTree.filter(p => p.endsWith('package.json')).slice(0, 2);
    packageFiles.forEach(p => keyFilePaths.add(p));

    const keyFiles = [];
    for (const p of Array.from(keyFilePaths).slice(0, 8)) {
      const content = await service.readFile(repoData.repoPath, p);
      if (content) keyFiles.push({ path: p, content });
    }

    const diagrams = await diagramAgent.generateDiagrams({
      repoUrl,
      readme: repoData.readme,
      fileTree: repoData.fileTree,
      keyFiles,
      findingsSummary,
    });

    session.progress = 100;
    session.status = 'complete';
    session.message = 'Analysis complete';
    session.result = {
      sessionId,
      repoUrl,
      normalizedRepoUrl: repoData.normalizedRepoUrl,
      commitHash: repoData.commitHash,
      createdAt: session.createdAt,
      completedAt: new Date().toISOString(),
      readme: repoData.readme,
      fileTree: repoData.fileTree,
      analysis: analysisResult,
      patches: [],
      diagrams,
    };

    logger.info({ sessionId }, 'Session complete');
    await sessionStore.saveCompleteSession(session.result);

  } catch (error: any) {
    logger.error({
      sessionId,
      err: error,
      message: error?.message,
      stack: error?.stack
    }, 'Analysis failed');
    session.status = 'error';
    session.error = error instanceof Error ? error.message : 'Unknown error';
    session.message = 'Analysis failed';
  }
}

/**
 * GET /api/analyze/:sessionId
 * Get analysis status and results
 */
router.get('/analyze/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    const stored = await sessionStore.loadSessionResult(sessionId);
    if (!stored) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({
      status: stored.error ? 'error' : 'complete',
      progress: 100,
      message: stored.error ? 'Analysis failed' : 'Analysis complete',
      result: stored,
      error: stored.error,
      createdAt: stored.createdAt,
    });
    return;
  }

  res.json({
    status: session.status,
    progress: session.progress,
    message: session.message,
    createdAt: session.createdAt,
    currentFile: session.currentFile,
    totalFiles: session.totalFiles,
    analyzedFiles: session.analyzedFiles,
    issuesPreview: session.issuesPreview,
    result: session.status === 'complete' ? session.result : undefined,
    error: session.status === 'error' ? session.error : undefined,
  });
});

/**
 * GET /api/sessions
 * List recent sessions stored on disk
 */
router.get('/sessions', async (_req: Request, res: Response) => {
  const sessions = await sessionStore.listSessions(30);
  res.json({ sessions });
});

/**
 * GET /api/sessions/:sessionId/file?path=...
 * Fetch a file's content from the stored repo clone
 */
router.get('/sessions/:sessionId/file', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const filePath = String(req.query.path || '');
  const maxBytesRaw = req.query.maxBytes;
  const maxBytes = typeof maxBytesRaw === 'string' ? Number(maxBytesRaw) : undefined;
  if (!filePath) {
    res.status(400).json({ error: 'path query param is required' });
    return;
  }

  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  const inMemory = sessions.get(sessionId);
  const fileTree = stored?.fileTree || inMemory?.fileTree;
  if (!fileTree) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const service = new GitHubService();
  if (!fileTree.includes(filePath)) {
    res.status(404).json({ error: 'File not found in session' });
    return;
  }

  const repoPath = getSessionRepoDir(sessionId);
  if (Number.isFinite(maxBytes) && (maxBytes as number) > 0) {
    const preview = await service.readFilePreview(repoPath, filePath, maxBytes as number);
    res.json({ path: filePath, content: preview.content, truncated: preview.truncated });
    return;
  }

  const content = await service.readFile(repoPath, filePath);
  res.json({ path: filePath, content, truncated: false });
});

/**
 * POST /api/sessions/:sessionId/diagrams/finding
 * Generate a detailed Mermaid diagram for a specific finding
 */
router.post('/sessions/:sessionId/diagrams/finding', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const findingId = String(req.body?.findingId || '');

  if (!findingId) {
    res.status(400).json({ error: 'findingId is required' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const finding = stored.analysis.allFindings.find(f => f.id === findingId);
  if (!finding) {
    res.status(404).json({ error: 'Finding not found' });
    return;
  }

  const existing = stored.diagrams.find(d => d.findingId === findingId);
  if (existing) {
    res.json({ diagram: existing });
    return;
  }

  const service = new GitHubService();
  const repoPath = getSessionRepoDir(sessionId);
  const fileContent = await service.readFile(repoPath, finding.file);

  let diagram;
  try {
    diagram = await diagramAgent.generateFindingDiagram({
      repoUrl: stored.repoUrl,
      readme: stored.readme,
      fileTree: stored.fileTree,
      finding,
      fileContent,
    });
  } catch (error: any) {
    logger.error({ err: error, sessionId, findingId }, 'Finding diagram generation failed');
    res.status(502).json({ error: error?.message || 'Failed to generate diagram' });
    return;
  }

  const storedDiagram: StoredDiagram = {
    name: `finding_${findingId}`,
    title: diagram.title,
    mermaid: diagram.mermaid,
    findingId,
  };

  const updated = {
    ...stored,
    diagrams: [
      ...stored.diagrams.filter(d => d.name !== storedDiagram.name),
      storedDiagram,
    ],
  };

  await sessionStore.saveCompleteSession(updated);
  const mem = sessions.get(sessionId);
  if (mem && mem.status === 'complete') {
    mem.result = updated;
  }

  res.json({ diagram: storedDiagram });
});

/**
 * POST /api/sessions/:sessionId/diagrams/fix
 * Fix a Mermaid diagram using the agent (best-effort)
 */
router.post('/sessions/:sessionId/diagrams/fix', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const name = String(req.body?.name || '');
  const error = String(req.body?.error || '');

  if (!name || !error) {
    res.status(400).json({ error: 'name and error are required' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const diagram = stored.diagrams.find(d => d.name === name);
  if (!diagram) {
    res.status(404).json({ error: 'Diagram not found' });
    return;
  }

  const fixed = await diagramFixAgent.fixMermaid({
    mermaid: diagram.mermaid,
    error,
    context: `title: ${diagram.title}, repo: ${stored.repoUrl}, findingId: ${diagram.findingId || 'n/a'}`,
  });

  if (!fixed) {
    res.status(500).json({ error: 'Failed to fix diagram' });
    return;
  }

  const updatedDiagram: StoredDiagram = { ...diagram, mermaid: fixed };
  const updated = {
    ...stored,
    diagrams: [
      ...stored.diagrams.filter(d => d.name !== updatedDiagram.name),
      updatedDiagram,
    ],
  };

  await sessionStore.saveCompleteSession(updated);
  const mem = sessions.get(sessionId);
  if (mem && mem.status === 'complete') {
    mem.result = updated;
  }

  res.json({ diagram: updatedDiagram });
});

function isSafeRelativePath(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.includes('..')) return false;
  if (path.isAbsolute(filePath)) return false;
  if (filePath.split('/').some(part => part.startsWith('.'))) return false;
  return true;
}

function isInSkippedDirectory(filePath: string): boolean {
  return SKIP_DIRECTORIES.some(skip => filePath.includes(`/${skip}/`) || filePath.startsWith(`${skip}/`) || filePath.includes(`\\${skip}\\`));
}

function isAnalyzableFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  return ANALYZABLE_EXTENSIONS.includes(ext) || filePath.endsWith('.env');
}

/**
 * POST /api/sessions/:sessionId/patchset
 * Generate a multi-file patch plan for a file's findings (proposal only)
 */
router.post('/sessions/:sessionId/patchset', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const rootFile = String(req.body?.file || '');

  if (!rootFile) {
    res.status(400).json({ error: 'file is required' });
    return;
  }

  if (!isSafeRelativePath(rootFile)) {
    res.status(400).json({ error: 'Invalid file path' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (!stored.fileTree.includes(rootFile)) {
    res.status(404).json({ error: 'File not found in session' });
    return;
  }

  const findings = stored.analysis.allFindings.filter(f => f.file === rootFile);
  if (findings.length === 0) {
    res.status(400).json({ error: 'No findings for this file' });
    return;
  }

  const service = new GitHubService();
  const repoPath = getSessionRepoDir(sessionId);

  const targetContent = await service.readFile(repoPath, rootFile);

  // Provide lightweight context: root package.json and nearby files.
  const packageJsonPath = stored.fileTree.includes('package.json')
    ? 'package.json'
    : stored.fileTree.find(p => p.endsWith('package.json'));

  const packageJson = packageJsonPath
    ? (await service.readFilePreview(repoPath, packageJsonPath, 12_000)).content
    : null;

  const dir = path.posix.dirname(rootFile);
  const nearbyPaths = stored.fileTree
    .filter(p => p !== rootFile && (dir === '.' ? !p.includes('/') : p.startsWith(`${dir}/`)))
    .slice(0, 6);

  const nearbyFiles: Array<{ path: string; content: string }> = [];
  for (const p of nearbyPaths) {
    const preview = await service.readFilePreview(repoPath, p, 10_000);
    if (preview.content) nearbyFiles.push({ path: p, content: preview.content });
  }

  const patchSetId = `patchset_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();

  const validate = (ops: Array<{ action: string; path: string; content: string }>) => {
    const errors: string[] = [];
    if (!Array.isArray(ops) || ops.length === 0) {
      errors.push('No operations returned.');
      return errors;
    }

    const seen = new Set<string>();
    let hasRoot = false;
    for (const op of ops) {
      const action = String(op.action || '').toLowerCase();
      const p = String(op.path || '');
      const content = typeof op.content === 'string' ? op.content : '';

      if (action !== 'modify' && action !== 'add') errors.push(`Invalid action for ${p || '(missing path)'}: ${action}`);
      if (!isSafeRelativePath(p)) errors.push(`Invalid path: ${p}`);
      if (isInSkippedDirectory(p)) errors.push(`Path in skipped directory: ${p}`);
      if (!isAnalyzableFile(p)) errors.push(`Non-analyzable file type: ${p}`);
      if (content.length < 1) errors.push(`Empty content for ${p}`);
      if (content.length > 250_000) errors.push(`Content too large for ${p}`);
      if (/hypothetical|placeholder/i.test(content)) errors.push(`Contains placeholder language (e.g., "hypothetical") in ${p}`);

      if (seen.has(p)) errors.push(`Duplicate operation for path: ${p}`);
      seen.add(p);

      if (action === 'modify' && !stored.fileTree.includes(p)) errors.push(`Modify references missing file: ${p}`);
      if (action === 'add' && stored.fileTree.includes(p)) errors.push(`Add references existing file: ${p}`);

      if (p === rootFile && action === 'modify') hasRoot = true;
    }

    if (!hasRoot) errors.push(`Operations must include a modify for the target file: ${rootFile}`);
    return errors;
  };

  // Best-effort: generate plan, validate, and retry once with validation feedback.
  let validationErrors: string[] = [];
  let plan = await patchSetAgent.generatePatchSet({
    repoUrl: stored.repoUrl,
    fileTree: stored.fileTree,
    packageJson,
    targetFile: { path: rootFile, content: targetContent },
    nearbyFiles,
    findings: findings.map(f => ({
      id: f.id,
      ruleId: f.ruleId,
      severity: f.severity,
      title: f.title,
      issue: f.issue,
      remediation: f.remediation,
      locations: f.locations || [],
    })),
  });

  if (!plan) {
    res.status(502).json({ error: 'Failed to generate patch plan' });
    return;
  }

  validationErrors = validate(plan.operations);
  if (validationErrors.length > 0) {
    const retry = await patchSetAgent.generatePatchSet({
      repoUrl: stored.repoUrl,
      fileTree: stored.fileTree,
      packageJson,
      targetFile: { path: rootFile, content: targetContent },
      nearbyFiles,
      findings: findings.map(f => ({
        id: f.id,
        ruleId: f.ruleId,
        severity: f.severity,
        title: f.title,
        issue: f.issue,
        remediation: f.remediation,
        locations: f.locations || [],
      })),
      validationErrors,
    });

    if (retry) {
      plan = retry;
      validationErrors = validate(plan.operations);
    }
  }

  if (validationErrors.length > 0) {
    res.status(422).json({
      error: 'Patch plan failed validation',
      details: validationErrors,
    });
    return;
  }

  const opOriginalCache = new Map<string, string>();
  opOriginalCache.set(rootFile, targetContent);

  const newPatches: StoredPatch[] = [];
  for (const op of plan.operations) {
    const action = op.action;
    const opPath = op.path;
    const originalContent = action === 'modify'
      ? (opOriginalCache.get(opPath) ?? await service.readFile(repoPath, opPath))
      : '';

    newPatches.push({
      file: opPath,
      action,
      patchSetId,
      originalContent,
      patchedContent: op.content,
      changes: plan.changes || [],
      explanation: plan.explanation || '',
      generatedAt: now,
      appliedAt: undefined,
    });
  }

  const updated = {
    ...stored,
    patches: [
      ...stored.patches.filter(p => !newPatches.some(np => np.file === p.file)),
      ...newPatches,
    ],
  };

  await sessionStore.saveCompleteSession(updated);
  const mem = sessions.get(sessionId);
  if (mem && mem.status === 'complete') {
    mem.result = updated;
  }

  res.json({ patchSetId, rootFile, patches: newPatches });
});

/**
 * POST /api/sessions/:sessionId/patchset/apply
 * Apply selected patches from a previously generated patchset
 */
router.post('/sessions/:sessionId/patchset/apply', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const patchSetId = String(req.body?.patchSetId || '');
  const files = Array.isArray(req.body?.files) ? req.body.files.map((f: any) => String(f || '')).filter(Boolean) : null;

  if (!patchSetId) {
    res.status(400).json({ error: 'patchSetId is required' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const candidates = stored.patches.filter(p => p.patchSetId === patchSetId);
  if (candidates.length === 0) {
    res.status(404).json({ error: 'Patchset not found' });
    return;
  }

  const toApply = files
    ? candidates.filter(p => files.includes(p.file))
    : candidates;

  if (toApply.length === 0) {
    res.status(400).json({ error: 'No matching patches selected' });
    return;
  }

  for (const f of toApply.map(p => p.file)) {
    if (!isSafeRelativePath(f)) {
      res.status(400).json({ error: `Invalid file path in selection: ${f}` });
      return;
    }
  }

  const service = new GitHubService();
  const repoPath = getSessionRepoDir(sessionId);
  const now = new Date().toISOString();

  const appliedFiles = new Set<string>();
  for (const patch of toApply) {
    await service.writeFile(repoPath, patch.file, patch.patchedContent);
    appliedFiles.add(patch.file);
  }

  const nextFileTree = [...stored.fileTree];
  for (const file of appliedFiles) {
    if (!nextFileTree.includes(file) && isAnalyzableFile(file) && !isInSkippedDirectory(file)) {
      nextFileTree.push(file);
    }
  }
  nextFileTree.sort();

  const updatedPatches = stored.patches.map(p => {
    if (!appliedFiles.has(p.file)) return p;
    return { ...p, appliedAt: now };
  });

  const updated = {
    ...stored,
    fileTree: nextFileTree,
    patches: updatedPatches,
  };

  await sessionStore.saveCompleteSession(updated);
  const mem = sessions.get(sessionId);
  if (mem && mem.status === 'complete') {
    mem.result = updated;
  }

  const applied = updatedPatches.filter(p => appliedFiles.has(p.file));
  res.json({ patches: applied, fileTree: nextFileTree });
});

/**
 * POST /api/sessions/:sessionId/patch
 * Generate (and optionally apply) a patch for a single file
 */
router.post('/sessions/:sessionId/patch', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const filePath = String(req.body?.file || '');
  const apply = Boolean(req.body?.apply);

  if (!filePath) {
    res.status(400).json({ error: 'file is required' });
    return;
  }

  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    res.status(400).json({ error: 'Invalid file path' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (!stored.fileTree.includes(filePath)) {
    res.status(404).json({ error: 'File not found in session' });
    return;
  }

  const findings = stored.analysis.allFindings.filter(f => f.file === filePath);
  if (findings.length === 0) {
    res.status(400).json({ error: 'No findings for this file' });
    return;
  }

  const service = new GitHubService();
  const repoPath = getSessionRepoDir(sessionId);
  const originalContent = await service.readFile(repoPath, filePath);

  const patcher = new PatcherAgent();
  const patch = await patcher.generatePatch(filePath, originalContent, findings);

  if (!patch.patchedContent) {
    res.status(500).json({ error: patch.error || 'Failed to generate patch' });
    return;
  }

  const now = new Date().toISOString();
  const storedPatch: StoredPatch = {
    file: filePath,
    originalContent: patch.originalContent,
    patchedContent: patch.patchedContent,
    changes: patch.changes,
    explanation: patch.explanation,
    generatedAt: now,
    appliedAt: apply ? now : undefined,
  };

  if (apply) {
    await service.writeFile(repoPath, filePath, patch.patchedContent);
  }

  const updated = {
    ...stored,
    patches: [
      ...stored.patches.filter(p => p.file !== filePath),
      storedPatch,
    ],
  };

  await sessionStore.saveCompleteSession(updated);
  const mem = sessions.get(sessionId);
  if (mem && mem.status === 'complete') {
    mem.result = updated;
  }
  res.json({ patch: storedPatch });
});

/**
 * POST /api/sessions/:sessionId/patch/apply
 * Apply a previously generated patch (no regeneration)
 */
router.post('/sessions/:sessionId/patch/apply', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const filePath = String(req.body?.file || '');

  if (!filePath) {
    res.status(400).json({ error: 'file is required' });
    return;
  }

  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    res.status(400).json({ error: 'Invalid file path' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const existing = stored.patches.find(p => p.file === filePath);
  if (!existing) {
    res.status(400).json({ error: 'No generated patch for this file' });
    return;
  }

  const service = new GitHubService();
  const repoPath = getSessionRepoDir(sessionId);
  await service.writeFile(repoPath, filePath, existing.patchedContent);

  const now = new Date().toISOString();
  const updatedPatch: StoredPatch = { ...existing, appliedAt: now };
  const updatedFileTree = stored.fileTree.includes(filePath) ? stored.fileTree : [...stored.fileTree, filePath].sort();
  const updated = {
    ...stored,
    fileTree: updatedFileTree,
    patches: [
      ...stored.patches.filter(p => p.file !== filePath),
      updatedPatch,
    ],
  };

  await sessionStore.saveCompleteSession(updated);
  const mem = sessions.get(sessionId);
  if (mem && mem.status === 'complete') {
    mem.result = updated;
  }
  res.json({ patch: updatedPatch });
});

/**
 * POST /api/sessions/:sessionId/verify
 * Re-analyze a single file in the stored repo clone and refresh findings (best-effort)
 */
router.post('/sessions/:sessionId/verify', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const filePath = String(req.body?.file || '');

  if (!filePath) {
    res.status(400).json({ error: 'file is required' });
    return;
  }

  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    res.status(400).json({ error: 'Invalid file path' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (!stored.fileTree.includes(filePath)) {
    res.status(404).json({ error: 'File not found in session' });
    return;
  }

  const service = new GitHubService();
  const repoPath = getSessionRepoDir(sessionId);
  const content = await service.readFile(repoPath, filePath);

  try {
    const analyzer = new AnalyzerAgent();
    const newFindings = await analyzer.analyzeFile(filePath, content, { force: true });

    const updatedAllFindings = [
      ...stored.analysis.allFindings.filter(f => f.file !== filePath),
      ...newFindings,
    ];

    const updatedAnalysis = analyzer.buildAnalysisResult(
      stored.analysis.totalFiles,
      stored.analysis.analyzedFiles,
      updatedAllFindings
    );

    const updated = {
      ...stored,
      analysis: updatedAnalysis,
    };

    await sessionStore.saveCompleteSession(updated);
    const mem = sessions.get(sessionId);
    if (mem && mem.status === 'complete') {
      mem.result = updated;
    }

    res.json({ analysis: updatedAnalysis, findings: newFindings });
  } catch (error: any) {
    logger.error({ err: error, sessionId, filePath }, 'Verify failed');
    res.status(502).json({ error: error?.message || 'Verification failed' });
  }
});

/**
 * POST /api/analyze-quick
 * Quick synchronous analysis (for smaller repos)
 */
router.post('/analyze-quick', async (req: Request, res: Response) => {
  const { repoUrl }: AnalyzeRequest = req.body;

  if (!repoUrl) {
    res.status(400).json({ error: 'repoUrl is required' });
    return;
  }

  const service = new GitHubService();

  try {
    // Clone and analyze
    const sessionId = `quick_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const repoData = await service.fetchRepoForAnalysis(sessionId, repoUrl);
    const analyzer = new AnalyzerAgent();
    const allFindings = [];
    let analyzedFiles = 0;
    const totalFiles = repoData.fileTree.length;
    for (const filePath of repoData.fileTree) {
      const content = await service.readFile(repoData.repoPath, filePath);
      if (!content) continue;
      const findings = await analyzer.analyzeFile(filePath, content);
      allFindings.push(...findings);
      analyzedFiles++;
    }
    const analysisResult = analyzer.buildAnalysisResult(totalFiles, analyzedFiles, allFindings);

    res.json({
      sessionId,
      repoUrl,
      normalizedRepoUrl: repoData.normalizedRepoUrl,
      commitHash: repoData.commitHash,
      readme: repoData.readme,
      fileTree: repoData.fileTree,
      analysis: analysisResult,
      patches: [],
      diagrams: [],
    });

  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Analysis failed',
    });
  }
});

export default router;
