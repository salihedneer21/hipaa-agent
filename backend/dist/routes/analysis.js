/**
 * Analysis Routes
 * API endpoints for HIPAA compliance analysis
 */
import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { GitHubService } from '../services/githubService.js';
import { AnalyzerAgent } from '../agents/analyzerAgent.js';
import { PatcherAgent } from '../agents/patcherAgent.js';
import { diagramAgent } from '../agents/diagramAgent.js';
import { diagramFixAgent } from '../agents/diagramFixAgent.js';
import { patchSetAgent } from '../agents/patchSetAgent.js';
import logger from '../utils/logger.js';
import { sessionStore } from '../services/sessionStore.js';
import { getSessionDir, getSessionRepoDir } from '../utils/storagePaths.js';
import { ANALYZABLE_EXTENSIONS, SKIP_DIRECTORIES } from '../knowledge/hipaaRules.js';
const router = Router();
// Store analysis sessions
const sessions = new Map();
const buildJobs = new Map();
/**
 * POST /api/analyze
 * Start analysis of a GitHub repository (public repos - no token needed)
 */
router.post('/analyze', async (req, res) => {
    const { repoUrl } = req.body;
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
async function runAnalysis(sessionId, repoUrl) {
    const session = sessions.get(sessionId);
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
            const filePath = repoData.fileTree[i];
            try {
                session.currentFile = filePath;
                session.message = `Analyzing ${i + 1}/${totalFiles}: ${filePath}`;
                session.progress = 15 + Math.round(((i + 1) / totalFiles) * 70);
                const content = await service.readFile(repoData.repoPath, filePath);
                if (!content)
                    continue;
                const findings = await analyzer.analyzeFile(filePath, content);
                allFindings.push(...findings);
                if (session.issuesPreview) {
                    for (const finding of findings) {
                        if (session.issuesPreview.length >= 6)
                            break;
                        if (session.issuesPreview.some(p => p.id === finding.id))
                            continue;
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
            }
            catch (error) {
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
        const keyFilePaths = new Set();
        for (const f of topFindings)
            keyFilePaths.add(f.file);
        const entrypointHints = repoData.fileTree.filter(p => /(index|main|app|server)\.(ts|tsx|js|jsx|py|go|java)$/i.test(p)).slice(0, 4);
        entrypointHints.forEach(p => keyFilePaths.add(p));
        const packageFiles = repoData.fileTree.filter(p => p.endsWith('package.json')).slice(0, 2);
        packageFiles.forEach(p => keyFilePaths.add(p));
        const keyFiles = [];
        for (const p of Array.from(keyFilePaths).slice(0, 8)) {
            const content = await service.readFile(repoData.repoPath, p);
            if (content)
                keyFiles.push({ path: p, content });
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
            resolvedFindings: [],
            patches: [],
            diagrams,
        };
        logger.info({ sessionId }, 'Session complete');
        await sessionStore.saveCompleteSession(session.result);
    }
    catch (error) {
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
router.get('/analyze/:sessionId', async (req, res) => {
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
router.get('/sessions', async (_req, res) => {
    const sessions = await sessionStore.listSessions(30);
    res.json({ sessions });
});
/**
 * GET /api/sessions/:sessionId/file?path=...
 * Fetch a file's content from the stored repo clone
 */
router.get('/sessions/:sessionId/file', async (req, res) => {
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
    if (Number.isFinite(maxBytes) && maxBytes > 0) {
        const preview = await service.readFilePreview(repoPath, filePath, maxBytes);
        res.json({ path: filePath, content: preview.content, truncated: preview.truncated });
        return;
    }
    const content = await service.readFile(repoPath, filePath);
    res.json({ path: filePath, content, truncated: false });
});
function appendBuildLog(job, chunk) {
    if (!chunk)
        return;
    job.logs += chunk;
    const MAX = 220_000;
    if (job.logs.length > MAX) {
        job.logs = job.logs.slice(job.logs.length - MAX);
        job.logsTruncated = true;
    }
}
async function fileExists(filePath) {
    try {
        await fs.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function runCommand(job, command, args, cwd, envOverrides) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env: {
                ...process.env,
                ...(envOverrides || {}),
                CI: '1',
                npm_config_loglevel: 'notice',
                npm_config_fund: 'false',
                npm_config_audit: 'false',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (d) => appendBuildLog(job, d.toString()));
        child.stderr.on('data', (d) => appendBuildLog(job, d.toString()));
        child.on('error', (err) => reject(err));
        child.on('close', (code) => resolve(typeof code === 'number' ? code : 0));
    });
}
async function runBuildJob(buildId, sessionId, options) {
    const job = buildJobs.get(buildId);
    if (!job)
        return;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Preparing build workspace…';
    const repoPath = getSessionRepoDir(sessionId);
    const workspaceRoot = path.join(getSessionDir(sessionId), 'build');
    const workspace = path.join(workspaceRoot, buildId);
    try {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.mkdir(workspace, { recursive: true });
        // Copy snapshot into workspace so installs/builds don't mutate the stored repo snapshot.
        // Node.js >=16 supports fs.cp.
        // @ts-ignore - types vary by TS/lib target
        await fs.cp(repoPath, workspace, { recursive: true });
        const packageJsonPath = path.join(workspace, 'package.json');
        if (!(await fileExists(packageJsonPath))) {
            throw new Error('No package.json found in repo snapshot (build runner currently supports Node/npm projects only).');
        }
        let scripts = {};
        try {
            const pkgRaw = await fs.readFile(packageJsonPath, 'utf-8');
            const pkg = JSON.parse(pkgRaw);
            scripts = (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
        }
        catch {
            scripts = {};
        }
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        if (options.install) {
            job.message = 'Installing dependencies…';
            const hasPackageLock = await fileExists(path.join(workspace, 'package-lock.json'));
            const installArgsBase = hasPackageLock ? ['ci'] : ['install'];
            if (options.ignoreScripts)
                installArgsBase.push('--ignore-scripts');
            // Prefer ci when lock exists; fallback to install if ci fails.
            let code = await runCommand(job, npmCmd, installArgsBase, workspace, options.env);
            if (code !== 0 && hasPackageLock) {
                appendBuildLog(job, `\n[hipaa-agent] npm ci failed (exit ${code}); retrying with npm install…\n`);
                const retryArgs = ['install'];
                if (options.ignoreScripts)
                    retryArgs.push('--ignore-scripts');
                code = await runCommand(job, npmCmd, retryArgs, workspace, options.env);
            }
            if (code !== 0)
                throw new Error(`Dependency install failed (exit ${code}).`);
        }
        const shouldBuild = options.kind === 'build' || options.kind === 'build+test';
        const shouldTest = options.kind === 'test' || options.kind === 'build+test';
        if (shouldBuild) {
            const buildScript = scripts.build ? 'build' : null;
            if (buildScript) {
                job.message = `Running ${buildScript}…`;
                const code = await runCommand(job, npmCmd, ['run', buildScript], workspace, options.env);
                if (code !== 0)
                    throw new Error(`${buildScript} failed (exit ${code}).`);
            }
            else {
                appendBuildLog(job, `\n[hipaa-agent] No build script found; skipping build.\n`);
            }
        }
        if (shouldTest) {
            if (scripts.test) {
                job.message = 'Running tests…';
                const code = await runCommand(job, npmCmd, ['test'], workspace, options.env);
                if (code !== 0)
                    throw new Error(`Tests failed (exit ${code}).`);
            }
            else {
                appendBuildLog(job, `\n[hipaa-agent] No test script found; skipping tests.\n`);
            }
        }
        job.status = 'complete';
        job.message = 'Build checks passed';
        job.exitCode = 0;
        job.completedAt = new Date().toISOString();
    }
    catch (err) {
        job.status = 'error';
        const message = err?.message || 'Build failed';
        job.message = message;
        job.exitCode = 1;
        appendBuildLog(job, `\n[hipaa-agent] Build failed: ${message}\n`);
        job.completedAt = new Date().toISOString();
    }
}
/**
 * POST /api/sessions/:sessionId/build
 * Run best-effort build/test checks in an isolated workspace (manual, optional)
 */
router.post('/sessions/:sessionId/build', async (req, res) => {
    const { sessionId } = req.params;
    const kindRaw = String(req.body?.kind || 'build+test');
    const kind = (kindRaw === 'build' || kindRaw === 'test' || kindRaw === 'build+test') ? kindRaw : 'build+test';
    const install = req.body?.install === false ? false : true;
    const ignoreScripts = req.body?.ignoreScripts === true;
    const envRaw = req.body?.env;
    let env;
    if (envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw)) {
        const out = {};
        for (const [k, v] of Object.entries(envRaw)) {
            const key = String(k || '').trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
                continue;
            const value = typeof v === 'string' ? v : (v == null ? '' : String(v));
            // Prevent extremely large env payloads.
            if (value.length > 10_000)
                continue;
            out[key] = value;
        }
        if (Object.keys(out).length > 0)
            env = out;
    }
    const stored = await sessionStore.loadSessionResult(sessionId);
    if (!stored) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    const buildId = `build_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const job = {
        buildId,
        sessionId,
        status: 'pending',
        message: 'Queued…',
        createdAt: new Date().toISOString(),
        logs: '',
        logsTruncated: false,
    };
    buildJobs.set(buildId, job);
    res.json({ buildId });
    runBuildJob(buildId, sessionId, { kind, install, ignoreScripts, env });
});
/**
 * GET /api/sessions/:sessionId/build/:buildId
 * Poll build status/logs
 */
router.get('/sessions/:sessionId/build/:buildId', async (req, res) => {
    const { sessionId, buildId } = req.params;
    const job = buildJobs.get(buildId);
    if (!job || job.sessionId !== sessionId) {
        res.status(404).json({ error: 'Build not found' });
        return;
    }
    res.json(job);
});
/**
 * POST /api/sessions/:sessionId/diagrams/finding
 * Generate a detailed Mermaid diagram for a specific finding
 */
router.post('/sessions/:sessionId/diagrams/finding', async (req, res) => {
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
    }
    catch (error) {
        logger.error({ err: error, sessionId, findingId }, 'Finding diagram generation failed');
        res.status(502).json({ error: error?.message || 'Failed to generate diagram' });
        return;
    }
    const storedDiagram = {
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
router.post('/sessions/:sessionId/diagrams/fix', async (req, res) => {
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
    const updatedDiagram = { ...diagram, mermaid: fixed };
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
function isSafeRelativePath(filePath) {
    if (!filePath)
        return false;
    if (filePath.includes('..'))
        return false;
    if (path.isAbsolute(filePath))
        return false;
    if (filePath.split('/').some(part => part.startsWith('.')))
        return false;
    return true;
}
function isInSkippedDirectory(filePath) {
    return SKIP_DIRECTORIES.some(skip => filePath.includes(`/${skip}/`) || filePath.startsWith(`${skip}/`) || filePath.includes(`\\${skip}\\`));
}
function isAnalyzableFile(filePath) {
    const ext = path.extname(filePath);
    return ANALYZABLE_EXTENSIONS.includes(ext) || filePath.endsWith('.env');
}
function toPosixPath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}
function stripCodeComments(code) {
    return code
        // block comments
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // line comments
        .replace(/\/\/.*$/gm, '');
}
function extractImportSpecifiers(code) {
    const cleaned = stripCodeComments(code);
    const specs = new Set();
    const patterns = [
        /\bfrom\s*['"]([^'"]+)['"]/g, // import/export ... from "x"
        /\bimport\s*['"]([^'"]+)['"]/g, // import "x"
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import("x")
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require("x")
        /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g,
        /\bexport\s+\{[^}]*\}\s+from\s*['"]([^'"]+)['"]/g,
    ];
    for (const re of patterns) {
        let match;
        while ((match = re.exec(cleaned))) {
            const spec = match[1];
            if (typeof spec === 'string' && spec.trim())
                specs.add(spec.trim());
        }
    }
    return Array.from(specs);
}
function resolveRelativeImportCandidates(importerPath, specifier) {
    const importer = toPosixPath(importerPath);
    const baseDir = path.posix.dirname(importer);
    const joined = path.posix.normalize(path.posix.join(baseDir, specifier));
    // Prevent escaping the repo root.
    if (joined.startsWith('..'))
        return [];
    const hasExt = Boolean(path.posix.extname(joined));
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml'];
    const candidates = [];
    if (hasExt) {
        candidates.push(joined);
    }
    else {
        for (const ext of exts)
            candidates.push(joined + ext);
        for (const ext of exts)
            candidates.push(path.posix.join(joined, `index${ext}`));
    }
    // De-dupe while preserving order
    const seen = new Set();
    const out = [];
    for (const c of candidates) {
        const v = toPosixPath(c);
        if (seen.has(v))
            continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}
function normalizeFindingKey(text) {
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
function findingStatusKey(f) {
    return `${toPosixPath(f.file)}|${String(f.ruleId || '')}|${normalizeFindingKey(f.title)}`;
}
/**
 * POST /api/sessions/:sessionId/patchset
 * Generate a multi-file patch plan for a file's findings (proposal only)
 */
router.post('/sessions/:sessionId/patchset', async (req, res) => {
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
    const nearbyFiles = [];
    for (const p of nearbyPaths) {
        const preview = await service.readFilePreview(repoPath, p, 10_000);
        if (preview.content)
            nearbyFiles.push({ path: p, content: preview.content });
    }
    const patchSetId = `patchset_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    const validate = (ops) => {
        const errors = [];
        if (!Array.isArray(ops) || ops.length === 0) {
            errors.push('No operations returned.');
            return errors;
        }
        const seen = new Set();
        let hasRoot = false;
        for (const op of ops) {
            const action = String(op.action || '').toLowerCase();
            const p = toPosixPath(String(op.path || ''));
            const content = typeof op.content === 'string' ? op.content : '';
            if (action !== 'modify' && action !== 'add')
                errors.push(`Invalid action for ${p || '(missing path)'}: ${action}`);
            if (!isSafeRelativePath(p))
                errors.push(`Invalid path: ${p}`);
            if (isInSkippedDirectory(p))
                errors.push(`Path in skipped directory: ${p}`);
            if (content.length < 1)
                errors.push(`Empty content for ${p}`);
            if (content.length > 250_000)
                errors.push(`Content too large for ${p}`);
            if (/hypothetical|placeholder/i.test(content))
                errors.push(`Contains placeholder language (e.g., "hypothetical") in ${p}`);
            if (seen.has(p))
                errors.push(`Duplicate operation for path: ${p}`);
            seen.add(p);
            if (action === 'modify' && !storedFileTreeSet.has(p))
                errors.push(`Modify references missing file: ${p}`);
            if (action === 'add' && storedFileTreeSet.has(p))
                errors.push(`Add references existing file: ${p}`);
            if (p === rootFile && action === 'modify')
                hasRoot = true;
        }
        if (!hasRoot)
            errors.push(`Operations must include a modify for the target file: ${rootFile}`);
        return errors;
    };
    // Best-effort: generate plan, validate, and retry once with validation feedback.
    let validationErrors = [];
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
    const opOriginalCache = new Map();
    opOriginalCache.set(rootFile, targetContent);
    const newPatches = [];
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
router.post('/sessions/:sessionId/patchset/apply', async (req, res) => {
    const { sessionId } = req.params;
    const patchSetId = String(req.body?.patchSetId || '');
    const files = Array.isArray(req.body?.files)
        ? req.body.files
            .map((f) => toPosixPath(String(f || '')))
            .filter((f) => Boolean(f))
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
    const candidatesByFile = new Map();
    for (const c of candidates)
        candidatesByFile.set(toPosixPath(c.file), c);
    const toApply = files
        ? files.map(f => candidatesByFile.get(f)).filter((p) => Boolean(p))
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
    const appliedFiles = new Set();
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
        if (!appliedFiles.has(p.file))
            return p;
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
router.post('/sessions/:sessionId/patch', async (req, res) => {
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
    const storedPatch = {
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
router.post('/sessions/:sessionId/patch/apply', async (req, res) => {
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
    const updatedPatch = { ...existing, appliedAt: now };
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
router.post('/sessions/:sessionId/patch/revert', async (req, res) => {
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
    }
    else {
        await service.writeFile(repoPath, filePath, existing.originalContent);
    }
    const updatedPatch = { ...existing, appliedAt: undefined };
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
router.post('/sessions/:sessionId/verify', async (req, res) => {
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
        const updatedAnalysis = analyzer.buildAnalysisResult(stored.analysis.totalFiles, stored.analysis.analyzedFiles, updatedAllFindings);
        // Track resolved findings so the UI can show "Done" vs "Not done".
        const now = new Date().toISOString();
        const hasAppliedPatchForFile = (stored.patches || []).some(p => toPosixPath(p.file) === filePath && Boolean(p.appliedAt));
        const openKeys = new Set(newFindings.map(f => findingStatusKey(f)));
        const existingResolved = Array.isArray(stored.resolvedFindings)
            ? stored.resolvedFindings
            : [];
        // Remove any previously resolved findings that have re-appeared.
        const filteredResolved = existingResolved.filter(r => !openKeys.has(findingStatusKey(r)));
        const nextResolved = [...filteredResolved];
        const resolvedKeys = new Set(nextResolved.map(r => findingStatusKey(r)));
        if (hasAppliedPatchForFile) {
            for (const oldFinding of prevFindingsForFile) {
                const k = findingStatusKey(oldFinding);
                if (openKeys.has(k))
                    continue;
                if (resolvedKeys.has(k))
                    continue;
                nextResolved.push({ ...oldFinding, resolvedAt: now });
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
    }
    catch (error) {
        logger.error({ err: error, sessionId, filePath }, 'Verify failed');
        res.status(502).json({ error: error?.message || 'Verification failed' });
    }
});
/**
 * POST /api/analyze-quick
 * Quick synchronous analysis (for smaller repos)
 */
router.post('/analyze-quick', async (req, res) => {
    const { repoUrl } = req.body;
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
            if (!content)
                continue;
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
    }
    catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Analysis failed',
        });
    }
});
export default router;
