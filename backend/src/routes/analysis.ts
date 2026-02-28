/**
 * Analysis Routes
 * API endpoints for HIPAA compliance analysis
 */

import { Router, type Request, type Response } from 'express';
import type { Router as ExpressRouter } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { GitHubService } from '../services/githubService.js';
import { githubAppService } from '../services/githubAppService.js';
import { githubInstallationsStore } from '../services/githubInstallationsStore.js';
import { AnalyzerAgent } from '../agents/analyzerAgent.js';
import { PatcherAgent } from '../agents/patcherAgent.js';
import { diagramAgent } from '../agents/diagramAgent.js';
import { diagramFixAgent } from '../agents/diagramFixAgent.js';
import { patchSetAgent } from '../agents/patchSetAgent.js';
import { researchBaaForProvider } from '../agents/baaResearchAgent.js';
import logger from '../utils/logger.js';
import { sessionStore } from '../services/sessionStore.js';
import type { StoredDiagram, StoredPatch, StoredResolvedFinding, StoredAnalysisFinding } from '../services/sessionStore.js';
import { getSessionDir, getSessionRepoDir } from '../utils/storagePaths.js';
import { ANALYZABLE_EXTENSIONS, SKIP_DIRECTORIES } from '../knowledge/hipaaRules.js';
import { detectThirdPartyServices, enrichWithLogo, type ThirdPartyServiceCard } from '../services/thirdPartyService.js';

const router: ExpressRouter = Router();

interface AnalyzeRequest {
  repoUrl: string;
  githubInstallationId?: number;
}

function getClientId(req: Request): string {
  const raw = String(req.header('x-hipaa-client-id') || '').trim();
  if (raw && /^[a-zA-Z0-9_-]{6,128}$/.test(raw)) return raw;
  return 'default';
}

function sanitizeRedirectPath(input: string): string {
  const raw = (input || '').trim();
  if (!raw || !raw.startsWith('/')) return '/';
  // Prevent open redirects to protocol-relative URLs or path traversal.
  if (raw.startsWith('//')) return '/';
  if (raw.includes('..')) return '/';
  return raw;
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
  githubInstallationId?: number;
  fileTree?: string[];
  totalFiles?: number;
  analyzedFiles?: number;
  currentFile?: string;
  issuesPreview?: IssuePreview[];
  result?: any;
  error?: string;
}>();

/**
 * GET /api/github/config
 * Lightweight config probe so the UI can decide whether to show GitHub App features.
 */
router.get('/github/config', async (_req: Request, res: Response) => {
  res.json({
    configured: githubAppService.isConfigured(),
    appSlug: githubAppService.getAppSlugOrNull(),
  });
});

/**
 * GET /api/github/install-url?redirect=/...
 * Creates a GitHub App installation URL with a signed state.
 */
router.get('/github/install-url', async (req: Request, res: Response) => {
  if (!githubAppService.isConfigured()) {
    res.status(501).json({ error: 'GitHub App is not configured on the server' });
    return;
  }

  const clientId = getClientId(req);
  const redirectPath = sanitizeRedirectPath(String(req.query.redirect || '/'));
  try {
    const url = githubAppService.createInstallUrl(clientId, redirectPath);
    res.json({ url });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to create install URL' });
  }
});

/**
 * GET /api/github/callback
 * GitHub App setup callback (set in GitHub App settings).
 */
router.get('/github/callback', async (req: Request, res: Response) => {
  const installationId = Number(req.query.installation_id);
  const state = String(req.query.state || '');

  if (!Number.isFinite(installationId) || installationId <= 0) {
    res.status(400).send('Missing installation_id');
    return;
  }

  const payload = githubAppService.verifyInstallState(state);
  if (!payload) {
    res.status(400).send('Invalid or expired state');
    return;
  }

  const clientId = payload.clientId;
  const redirectPath = sanitizeRedirectPath(payload.redirectPath);

  let accountLogin: string | undefined;
  let accountType: 'User' | 'Organization' | undefined;
  let repositorySelection: 'all' | 'selected' | undefined;
  let permissions: Record<string, string> | undefined;

  try {
    const info = await githubAppService.getInstallation(installationId);
    accountLogin = info.account?.login;
    accountType = info.account?.type as any;
    repositorySelection = info.repository_selection;
    permissions = info.permissions || undefined;
  } catch {
    // Non-fatal: still store installation id for later retries.
  }

  await githubInstallationsStore.upsertInstallation(clientId, {
    installationId,
    accountLogin,
    accountType,
    repositorySelection,
    permissions,
  });

  const frontendUrl = (process.env.HIPAA_AGENT_FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const sep = redirectPath.includes('?') ? '&' : '?';
  res.redirect(`${frontendUrl}${redirectPath}${sep}github_installation_id=${encodeURIComponent(String(installationId))}`);
});

/**
 * GET /api/github/installations
 * List GitHub App installations for this browser client.
 */
router.get('/github/installations', async (req: Request, res: Response) => {
  const clientId = getClientId(req);
  const installations = await githubInstallationsStore.listInstallations(clientId);
  res.json({ installations });
});

/**
 * GET /api/github/repos?installationId=123
 * List repositories accessible by a given installation.
 */
router.get('/github/repos', async (req: Request, res: Response) => {
  if (!githubAppService.isConfigured()) {
    res.status(501).json({ error: 'GitHub App is not configured on the server' });
    return;
  }

  const clientId = getClientId(req);
  const installationId = Number(req.query.installationId);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    res.status(400).json({ error: 'installationId is required' });
    return;
  }

  const allowed = await githubInstallationsStore.getInstallation(clientId, installationId);
  if (!allowed) {
    res.status(403).json({ error: 'Unknown installation for this client' });
    return;
  }

  try {
    const repos = await githubAppService.listInstallationRepositories(installationId);
    res.json({
      installationId,
      repos: repos.map(r => ({
        id: r.id,
        fullName: r.full_name,
        name: r.name,
        private: r.private,
        owner: r.owner?.login,
        defaultBranch: r.default_branch,
      })),
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Failed to list repositories' });
  }
});

/**
 * POST /api/analyze
 * Start analysis of a repository (local path or GitHub; GitHub App installation optional for private repos)
 */
router.post('/analyze', async (req: Request, res: Response) => {
  const body = (req.body || {}) as Partial<AnalyzeRequest>;
  const repoUrl = String(body.repoUrl || '');
  const githubInstallationId = body.githubInstallationId != null && body.githubInstallationId !== ('' as any)
    ? Number(body.githubInstallationId)
    : undefined;

  if (!repoUrl) {
    res.status(400).json({ error: 'repoUrl is required' });
    return;
  }

  const clientId = getClientId(req);
  if (githubInstallationId != null) {
    if (!Number.isFinite(githubInstallationId) || (githubInstallationId as number) <= 0) {
      res.status(400).json({ error: 'githubInstallationId must be a positive number' });
      return;
    }
    if (!githubAppService.isConfigured()) {
      res.status(501).json({ error: 'GitHub App is not configured on the server' });
      return;
    }
    const allowed = await githubInstallationsStore.getInstallation(clientId, githubInstallationId as number);
    if (!allowed) {
      res.status(403).json({ error: 'Unknown GitHub installation for this client. Connect GitHub first.' });
      return;
    }
  }

  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Initialize session
  sessions.set(sessionId, {
    status: 'pending',
    progress: 0,
    message: 'Starting analysis...',
    createdAt: new Date().toISOString(),
    githubInstallationId: githubInstallationId != null ? (githubInstallationId as number) : undefined,
  });

  // Return session ID immediately
  res.json({ sessionId, message: 'Analysis started' });

  // Run analysis in background
  runAnalysis(sessionId, repoUrl, { clientId, githubInstallationId: githubInstallationId != null ? (githubInstallationId as number) : undefined });
});

function parseGitHubRepoFullNameFromUrl(normalizedRepoUrl: string): string | null {
  try {
    const u = new URL(normalizedRepoUrl);
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
}

async function runAnalysis(sessionId: string, repoUrl: string, options: { clientId: string; githubInstallationId?: number }) {
  const session = sessions.get(sessionId)!;
  const service = new GitHubService();

  try {
    logger.info({ sessionId, repoUrl }, 'Starting analysis');

    // Step 1: Clone repository
    session.status = 'analyzing';
    session.progress = 5;
    session.message = 'Cloning repository...';

    const githubInstallationId = options.githubInstallationId;
    let authToken: string | undefined;
    if (githubInstallationId != null) {
      const allowed = await githubInstallationsStore.getInstallation(options.clientId, githubInstallationId);
      if (!allowed) {
        throw new Error('GitHub installation is not connected for this client. Reconnect GitHub and retry.');
      }
      const tok = await githubAppService.createInstallationAccessToken(githubInstallationId);
      authToken = tok.token;
    }

    const repoData = await service.fetchRepoForAnalysis(sessionId, repoUrl, { authToken });
    logger.info({ sessionId, fileCount: repoData.fileTree.length }, 'Repository cloned');

    session.repoUrl = repoUrl;
    session.normalizedRepoUrl = repoData.normalizedRepoUrl;
    session.commitHash = repoData.commitHash;
    session.githubInstallationId = githubInstallationId;
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

    session.progress = 86;
    session.message = `Found ${analysisResult.totalFindings} issues. Identifying third-party services...`;

    // Step 3: Detect third-party services (dependency-based, best-effort)
    let thirdPartyServices: ThirdPartyServiceCard[] = [];
    try {
      const detected = await detectThirdPartyServices(repoData.repoPath, repoData.fileTree);
      thirdPartyServices = detected.map(enrichWithLogo);
    } catch (e: any) {
      logger.warn({ err: e, sessionId }, 'Third-party detection failed (ignored)');
      thirdPartyServices = [];
    }

    // Step 4: Research BAA availability (best-effort; bounded)
    if (thirdPartyServices.length > 0) {
      session.progress = 89;
      session.message = `Researching BAAs for ${thirdPartyServices.length} third-party service${thirdPartyServices.length === 1 ? '' : 's'}...`;

      const MAX_RESEARCH = Number(process.env.HIPAA_AGENT_BAA_RESEARCH_MAX || 10);
      const next: ThirdPartyServiceCard[] = [];
      for (let i = 0; i < thirdPartyServices.length; i++) {
        const svc = thirdPartyServices[i]!;
        if (i >= MAX_RESEARCH) {
          next.push(svc);
          continue;
        }
        try {
          const baa = await researchBaaForProvider({ name: svc.name, domain: svc.domain });
          next.push({ ...svc, baa });
        } catch {
          next.push(svc);
        }
      }
      thirdPartyServices = next;
    }

    session.progress = 92;
    session.message = `Generating diagrams...`;

    // Step 5: Generate Mermaid diagrams (best-effort)
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

    const repoFullName = repoData.normalizedRepoUrl ? parseGitHubRepoFullNameFromUrl(repoData.normalizedRepoUrl) : null;
    session.result = {
      sessionId,
      repoUrl,
      normalizedRepoUrl: repoData.normalizedRepoUrl,
      commitHash: repoData.commitHash,
      github: (githubInstallationId != null && repoFullName)
        ? { installationId: githubInstallationId, repoFullName }
        : undefined,
      createdAt: session.createdAt,
      completedAt: new Date().toISOString(),
      readme: repoData.readme,
      fileTree: repoData.fileTree,
      analysis: analysisResult,
      resolvedFindings: [],
      patches: [],
      diagrams,
      thirdPartyServices,
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
 * DELETE /api/sessions/:sessionId
 * Remove a stored session (repo snapshot + result)
 */
router.delete('/sessions/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(sessionId)) {
    res.status(400).json({ error: 'Invalid sessionId' });
    return;
  }

  const inMemory = sessions.get(sessionId);
  if (inMemory && inMemory.status !== 'complete' && inMemory.status !== 'error') {
    res.status(409).json({ error: 'Cannot delete an in-progress session' });
    return;
  }

  sessions.delete(sessionId);
  try {
    await fs.rm(getSessionDir(sessionId), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to delete session' });
  }
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(repoPath: string, args: string[], envOverrides?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: {
        ...process.env,
        ...(envOverrides || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr }));
    child.on('error', () => resolve({ code: 1, stdout, stderr: stderr || 'Failed to start git process' }));
  });
}

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

function toPosixPath(filePath: string): string {
  return String(filePath || '').replace(/\\/g, '/');
}

function stripCodeComments(code: string): string {
  return code
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // line comments
    .replace(/\/\/.*$/gm, '');
}

function extractImportSpecifiers(code: string): string[] {
  const cleaned = stripCodeComments(code);
  const specs = new Set<string>();
  const patterns: RegExp[] = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import/export ... from "x"
    /\bimport\s*['"]([^'"]+)['"]/g, // import "x"
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import("x")
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require("x")
    /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g,
    /\bexport\s+\{[^}]*\}\s+from\s*['"]([^'"]+)['"]/g,
  ];

  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(cleaned))) {
      const spec = match[1];
      if (typeof spec === 'string' && spec.trim()) specs.add(spec.trim());
    }
  }

  return Array.from(specs);
}

function resolveRelativeImportCandidates(importerPath: string, specifier: string): string[] {
  const importer = toPosixPath(importerPath);
  const baseDir = path.posix.dirname(importer);
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));

  // Prevent escaping the repo root.
  if (joined.startsWith('..')) return [];

  const hasExt = Boolean(path.posix.extname(joined));
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml'];

  const candidates: string[] = [];
  if (hasExt) {
    candidates.push(joined);
  } else {
    for (const ext of exts) candidates.push(joined + ext);
    for (const ext of exts) candidates.push(path.posix.join(joined, `index${ext}`));
  }

  // De-dupe while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const v = toPosixPath(c);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeFindingKey(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[`"'’“”]/g, '')
    // Remove explicit line references that often create duplicate keys.
    .replace(/\b(lines?|ln)\s*\d+(\s*-\s*\d+)?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function findingStatusKey(f: Pick<StoredAnalysisFinding, 'file' | 'ruleId' | 'title'>): string {
  return `${toPosixPath(f.file)}|${String(f.ruleId || '')}|${normalizeFindingKey(f.title)}`;
}

/**
 * POST /api/sessions/:sessionId/patchset
 * Generate a multi-file patch plan for a file's findings (proposal only)
 */
router.post('/sessions/:sessionId/patchset', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const rootFile = toPosixPath(String(req.body?.file || ''));
  const requestedFindingId = String(req.body?.findingId || '').trim();

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

  const storedFileTreeSet = new Set(stored.fileTree.map(toPosixPath));
  if (!storedFileTreeSet.has(rootFile)) {
    res.status(404).json({ error: 'File not found in session' });
    return;
  }

  let findings = stored.analysis.allFindings.filter(f => f.file === rootFile);
  if (requestedFindingId) {
    const match = findings.find(f => f.id === requestedFindingId);
    if (!match) {
      res.status(404).json({ error: 'Finding not found in this file' });
      return;
    }
    findings = [match];
  }
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
      const p = toPosixPath(String(op.path || ''));
      const content = typeof op.content === 'string' ? op.content : '';

      if (action !== 'modify' && action !== 'add') errors.push(`Invalid action for ${p || '(missing path)'}: ${action}`);
      if (!isSafeRelativePath(p)) errors.push(`Invalid path: ${p}`);
      if (isInSkippedDirectory(p)) errors.push(`Path in skipped directory: ${p}`);
      if (content.length < 1) errors.push(`Empty content for ${p}`);
      if (content.length > 250_000) errors.push(`Content too large for ${p}`);
      if (/hypothetical|placeholder/i.test(content)) errors.push(`Contains placeholder language (e.g., "hypothetical") in ${p}`);

      if (seen.has(p)) errors.push(`Duplicate operation for path: ${p}`);
      seen.add(p);

      if (action === 'modify' && !storedFileTreeSet.has(p)) errors.push(`Modify references missing file: ${p}`);
      if (action === 'add' && storedFileTreeSet.has(p)) errors.push(`Add references existing file: ${p}`);

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
  const files: string[] | null = Array.isArray(req.body?.files)
    ? (req.body.files as unknown[])
      .map((f) => toPosixPath(String(f || '')))
      .filter((f): f is string => Boolean(f))
    : null;

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

  const storedFileTreeSet = new Set(stored.fileTree.map(toPosixPath));
  const candidatesByFile = new Map<string, StoredPatch>();
  for (const c of candidates) candidatesByFile.set(toPosixPath(c.file), c);

  const toApply = files
    ? files.map(f => candidatesByFile.get(f)).filter((p): p is StoredPatch => Boolean(p))
    : candidates;

  if (toApply.length === 0) {
    res.status(400).json({ error: 'No matching patches selected' });
    return;
  }

  for (const f of toApply.map(p => p.file)) {
    const fp = toPosixPath(f);
    if (!isSafeRelativePath(fp)) {
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
    if (!nextFileTree.includes(file) && !isInSkippedDirectory(file) && isSafeRelativePath(toPosixPath(file))) {
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
  const filePath = toPosixPath(String(req.body?.file || ''));
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

  const storedFileTreeSet = new Set(stored.fileTree.map(toPosixPath));
  if (!storedFileTreeSet.has(filePath)) {
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

  // Minimal validation: block placeholder "fixes" and rely on real builds for correctness.
  if (/hypothetical|placeholder/i.test(patch.patchedContent)) {
    res.status(422).json({ error: 'Generated patch failed validation', details: ['Patch contains placeholder language (e.g., "hypothetical").'] });
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
  const filePath = toPosixPath(String(req.body?.file || ''));

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

  // Minimal validation: prevent applying placeholder "fixes".
  if (/hypothetical|placeholder/i.test(existing.patchedContent || '')) {
    res.status(422).json({ error: 'Patch failed validation', details: ['Patch contains placeholder language (e.g., "hypothetical").'] });
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
 * POST /api/sessions/:sessionId/patch/revert
 * Revert an applied patch back to its original content (best-effort)
 */
router.post('/sessions/:sessionId/patch/revert', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const filePath = toPosixPath(String(req.body?.file || ''));

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
  if (!existing || !existing.appliedAt) {
    res.status(400).json({ error: 'No applied patch found for this file' });
    return;
  }

  const service = new GitHubService();
  const repoPath = getSessionRepoDir(sessionId);

  const action = existing.action || 'modify';
  let nextFileTree = stored.fileTree;

  if (action === 'add') {
    // Remove added file entirely.
    await fs.rm(path.join(repoPath, filePath), { force: true });
    nextFileTree = stored.fileTree.filter(f => f !== filePath);
  } else {
    await service.writeFile(repoPath, filePath, existing.originalContent);
  }

  const updatedPatch: StoredPatch = { ...existing, appliedAt: undefined };
  const updated = {
    ...stored,
    fileTree: nextFileTree,
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

  res.json({ patch: updatedPatch, fileTree: nextFileTree });
});

/**
 * POST /api/sessions/:sessionId/verify
 * Re-analyze a single file in the stored repo clone and refresh findings (best-effort)
 */
router.post('/sessions/:sessionId/verify', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const filePath = toPosixPath(String(req.body?.file || ''));

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
    const prevFindingsForFile = stored.analysis.allFindings.filter(f => toPosixPath(f.file) === filePath);
    const newFindings = await analyzer.analyzeFile(filePath, content, { force: true });

    const updatedAllFindings = [
      ...stored.analysis.allFindings.filter(f => toPosixPath(f.file) !== filePath),
      ...newFindings,
    ];

    const updatedAnalysis = analyzer.buildAnalysisResult(
      stored.analysis.totalFiles,
      stored.analysis.analyzedFiles,
      updatedAllFindings
    );

    // Track resolved findings so the UI can show "Done" vs "Not done".
    const now = new Date().toISOString();
    const hasAppliedPatchForFile = (stored.patches || []).some(p => toPosixPath(p.file) === filePath && Boolean(p.appliedAt));
    const openKeys = new Set(newFindings.map(f => findingStatusKey(f as any)));
    const existingResolved: StoredResolvedFinding[] = Array.isArray(stored.resolvedFindings)
      ? stored.resolvedFindings
      : [];

    // Remove any previously resolved findings that have re-appeared.
    const filteredResolved = existingResolved.filter(r => !openKeys.has(findingStatusKey(r)));
    const nextResolved: StoredResolvedFinding[] = [...filteredResolved];
    const resolvedKeys = new Set(nextResolved.map(r => findingStatusKey(r)));

    if (hasAppliedPatchForFile) {
      for (const oldFinding of prevFindingsForFile) {
        const k = findingStatusKey(oldFinding);
        if (openKeys.has(k)) continue;
        if (resolvedKeys.has(k)) continue;
        nextResolved.push({ ...(oldFinding as any), resolvedAt: now });
        resolvedKeys.add(k);
      }
    }

    const updated = {
      ...stored,
      analysis: updatedAnalysis,
      resolvedFindings: nextResolved,
    };

    await sessionStore.saveCompleteSession(updated);
    const mem = sessions.get(sessionId);
    if (mem && mem.status === 'complete') {
      mem.result = updated;
    }

    res.json({ analysis: updatedAnalysis, findings: newFindings, resolvedFindings: nextResolved });
  } catch (error: any) {
    logger.error({ err: error, sessionId, filePath }, 'Verify failed');
    res.status(502).json({ error: error?.message || 'Verification failed' });
  }
});

/**
 * POST /api/sessions/:sessionId/third-party/confirm
 * Record whether a BAA is confirmed for a detected third-party service.
 */
router.post('/sessions/:sessionId/third-party/confirm', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const providerId = String(req.body?.providerId || '').trim();
  const statusRaw = String(req.body?.status || '').trim();

  if (!providerId) {
    res.status(400).json({ error: 'providerId is required' });
    return;
  }

  const status = statusRaw === 'confirmed' || statusRaw === 'not_confirmed' || statusRaw === 'unknown'
    ? statusRaw
    : null;

  if (!status) {
    res.status(400).json({ error: 'status must be one of: confirmed, not_confirmed, unknown' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const existing = Array.isArray((stored as any).thirdPartyServices) ? ((stored as any).thirdPartyServices as any[]) : [];
  const found = existing.some(s => String(s?.id || '') === providerId);
  if (!found) {
    res.status(404).json({ error: 'Provider not found in this session' });
    return;
  }

  const now = new Date().toISOString();
  const next = existing.map((svc) => {
    if (String(svc?.id || '') !== providerId) return svc;
    return {
      ...svc,
      confirmation: { status, updatedAt: now },
    };
  });

  const updated = {
    ...stored,
    thirdPartyServices: next,
  };

  await sessionStore.saveCompleteSession(updated);
  const mem = sessions.get(sessionId);
  if (mem && mem.status === 'complete') {
    mem.result = updated;
  }

  res.json({ thirdPartyServices: next });
});

/**
 * POST /api/sessions/:sessionId/github/pr
 * Create a GitHub Pull Request for the applied patches in this session (GitHub App installation required).
 */
router.post('/sessions/:sessionId/github/pr', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  if (!githubAppService.isConfigured()) {
    res.status(501).json({ error: 'GitHub App is not configured on the server' });
    return;
  }

  const stored = await sessionStore.loadSessionResult(sessionId);
  if (!stored) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const body = (req.body || {}) as any;
  const clientId = getClientId(req);

  const installationId: number | null = (() => {
    const fromStored = (stored as any).github?.installationId;
    if (typeof fromStored === 'number' && Number.isFinite(fromStored) && fromStored > 0) return fromStored;
    const raw = body.installationId ?? body.githubInstallationId;
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const repoFullName: string | null = (() => {
    const fromStored = (stored as any).github?.repoFullName;
    if (typeof fromStored === 'string' && fromStored.includes('/')) return fromStored;
    const raw = String(body.repoFullName || '').trim();
    return raw && raw.includes('/') ? raw : null;
  })();

  if (!installationId || !repoFullName) {
    res.status(400).json({ error: 'Missing GitHub repo context. Re-run analysis after connecting GitHub and selecting a repo.' });
    return;
  }

  const allowed = await githubInstallationsStore.getInstallation(clientId, installationId);
  if (!allowed) {
    res.status(403).json({ error: 'Unknown GitHub installation for this client' });
    return;
  }

  const repoPath = getSessionRepoDir(sessionId);
  if (!(await fileExists(path.join(repoPath, '.git')))) {
    res.status(400).json({ error: 'This session snapshot is not a git repo. PR creation is supported for GitHub-cloned sessions only.' });
    return;
  }

  const appliedPatches = (stored.patches || []).filter(p => Boolean(p.appliedAt));
  if (appliedPatches.length === 0) {
    res.status(400).json({ error: 'No applied patches found for this session' });
    return;
  }

  const status = await runGit(repoPath, ['status', '--porcelain']);
  if (status.code !== 0) {
    res.status(502).json({ error: status.stderr || 'git status failed' });
    return;
  }
  if (!status.stdout.trim()) {
    res.status(400).json({ error: 'No working tree changes detected to commit' });
    return;
  }

  const [owner, repo] = repoFullName.split('/', 2) as [string, string];
  if (!owner || !repo) {
    res.status(400).json({ error: 'Invalid repoFullName (expected owner/repo)' });
    return;
  }

  const prTitle = String(body.title || '').trim() || 'HIPAA Agent: security fixes';
  const defaultBody = (() => {
    const resolvedCount = Array.isArray((stored as any).resolvedFindings) ? (stored as any).resolvedFindings.length : 0;
    const lines: string[] = [];
    lines.push('## Summary');
    lines.push('');
    lines.push(`- Applied patches: ${appliedPatches.length}`);
    if (resolvedCount) lines.push(`- Resolved findings (verified): ${resolvedCount}`);
    lines.push('');
    lines.push('## Changes');
    lines.push('');
    for (const p of appliedPatches.slice(0, 30)) {
      lines.push(`- ${p.file}${p.explanation ? ` — ${p.explanation}` : ''}`);
    }
    if (appliedPatches.length > 30) lines.push(`- …and ${appliedPatches.length - 30} more`);
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    lines.push('- Please run the project build/tests before merging.');
    lines.push('- Generated by HIPAA Agent.');
    lines.push('');
    return lines.join('\n');
  })();
  const prBody = String(body.body || '').trim() || defaultBody;

  const branchBase = `hipaa-agent/fix-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-10) || 'session'}-${Date.now().toString(36)}`;
  const branchName = String(body.branch || '').trim() || branchBase;

  const { token } = await githubAppService.createInstallationAccessToken(installationId);

  const askpassPath = path.join(getSessionDir(sessionId), `.git-askpass_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const askpassScript = `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$HIPAA_AGENT_GIT_TOKEN" ;;
  *) echo "$HIPAA_AGENT_GIT_TOKEN" ;;
esac
`;

  await fs.writeFile(askpassPath, askpassScript, { encoding: 'utf-8', mode: 0o700 });
  const gitEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askpassPath,
    HIPAA_AGENT_GIT_TOKEN: token,
  };

  try {
    const checkout = await runGit(repoPath, ['checkout', '-b', branchName]);
    if (checkout.code !== 0) {
      res.status(502).json({ error: checkout.stderr || 'git checkout -b failed' });
      return;
    }

    const add = await runGit(repoPath, ['add', '-A']);
    if (add.code !== 0) {
      res.status(502).json({ error: add.stderr || 'git add failed' });
      return;
    }

    const commit = await runGit(repoPath, [
      '-c', 'user.email=hipaa-agent@users.noreply.github.com',
      '-c', 'user.name=HIPAA Agent',
      'commit',
      '-m',
      prTitle,
    ]);
    if (commit.code !== 0) {
      res.status(502).json({ error: commit.stderr || 'git commit failed' });
      return;
    }

    const push = await runGit(repoPath, ['push', '-u', 'origin', branchName], gitEnv);
    if (push.code !== 0) {
      res.status(502).json({ error: push.stderr || 'git push failed' });
      return;
    }

    let baseBranch = String(body.base || '').trim();
    if (!baseBranch) {
      try {
        const repoInfo = await githubAppService.getRepo(owner, repo, installationId);
        baseBranch = repoInfo.default_branch || 'main';
      } catch {
        baseBranch = 'main';
      }
    }

    const pr = await githubAppService.createPullRequest({
      installationId,
      owner,
      repo,
      title: prTitle,
      body: prBody,
      head: `${owner}:${branchName}`,
      base: baseBranch,
    });

    res.json({
      installationId,
      repoFullName,
      branch: branchName,
      base: baseBranch,
      pr,
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Failed to create PR' });
  } finally {
    await fs.rm(askpassPath, { force: true });
  }
});

/**
 * POST /api/analyze-quick
 * Quick synchronous analysis (for smaller repos)
 */
router.post('/analyze-quick', async (req: Request, res: Response) => {
  const body = (req.body || {}) as Partial<AnalyzeRequest>;
  const repoUrl = String(body.repoUrl || '');
  const githubInstallationId = body.githubInstallationId != null && body.githubInstallationId !== ('' as any)
    ? Number(body.githubInstallationId)
    : undefined;

  if (!repoUrl) {
    res.status(400).json({ error: 'repoUrl is required' });
    return;
  }

  const service = new GitHubService();

  try {
    // Clone and analyze
    const sessionId = `quick_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const clientId = getClientId(req);
    let authToken: string | undefined;
    if (githubInstallationId != null) {
      if (!githubAppService.isConfigured()) {
        res.status(501).json({ error: 'GitHub App is not configured on the server' });
        return;
      }
      const allowed = await githubInstallationsStore.getInstallation(clientId, githubInstallationId);
      if (!allowed) {
        res.status(403).json({ error: 'Unknown GitHub installation for this client. Connect GitHub first.' });
        return;
      }
      const tok = await githubAppService.createInstallationAccessToken(githubInstallationId);
      authToken = tok.token;
    }

    const repoData = await service.fetchRepoForAnalysis(sessionId, repoUrl, { authToken });
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

    let thirdPartyServices: ThirdPartyServiceCard[] = [];
    try {
      const detected = await detectThirdPartyServices(repoData.repoPath, repoData.fileTree);
      thirdPartyServices = detected.map(enrichWithLogo);
      const MAX_RESEARCH = Number(process.env.HIPAA_AGENT_BAA_RESEARCH_MAX || 10);
      const next: ThirdPartyServiceCard[] = [];
      for (let i = 0; i < thirdPartyServices.length; i++) {
        const svc = thirdPartyServices[i]!;
        if (i >= MAX_RESEARCH) {
          next.push(svc);
          continue;
        }
        try {
          const baa = await researchBaaForProvider({ name: svc.name, domain: svc.domain });
          next.push({ ...svc, baa });
        } catch {
          next.push(svc);
        }
      }
      thirdPartyServices = next;
    } catch {
      thirdPartyServices = [];
    }

    res.json({
      sessionId,
      repoUrl,
      normalizedRepoUrl: repoData.normalizedRepoUrl,
      commitHash: repoData.commitHash,
      readme: repoData.readme,
      fileTree: repoData.fileTree,
      analysis: analysisResult,
      thirdPartyServices,
      github: undefined,
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
