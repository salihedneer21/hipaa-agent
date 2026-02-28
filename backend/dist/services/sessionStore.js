import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { SESSIONS_DIR, getSessionDir, getSessionMetaPath, getSessionResultPath, getSessionDiagramsDir, getSessionSummaryPath, } from '../utils/storagePaths.js';
async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}
async function writeJson(filePath, data) {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
async function readJson(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function buildSummaryMarkdown(result) {
    const counts = {
        critical: result.analysis.findingsBySeverity.critical.length,
        high: result.analysis.findingsBySeverity.high.length,
        medium: result.analysis.findingsBySeverity.medium.length,
        low: result.analysis.findingsBySeverity.low.length,
        total: result.analysis.totalFindings,
    };
    const top = [
        ...result.analysis.findingsBySeverity.critical,
        ...result.analysis.findingsBySeverity.high,
        ...result.analysis.findingsBySeverity.medium,
        ...result.analysis.findingsBySeverity.low,
    ].slice(0, 20);
    const lines = [];
    lines.push(`# HIPAA Agent Scan Summary`);
    lines.push('');
    lines.push(`- Session: ${result.sessionId}`);
    lines.push(`- Repo: ${result.repoUrl}`);
    if (result.commitHash)
        lines.push(`- Commit: ${result.commitHash}`);
    lines.push(`- Created: ${result.createdAt}`);
    if (result.completedAt)
        lines.push(`- Completed: ${result.completedAt}`);
    lines.push(`- Files analyzed: ${result.analysis.analyzedFiles}/${result.analysis.totalFiles}`);
    lines.push(`- Findings: ${counts.total} (Critical ${counts.critical}, High ${counts.high}, Medium ${counts.medium}, Low ${counts.low})`);
    lines.push(`- Patches generated: ${result.patches.length}`);
    lines.push(`- Diagrams: ${result.diagrams.length}`);
    lines.push('');
    lines.push(`## Top Findings`);
    lines.push('');
    if (top.length === 0) {
        lines.push(`No findings.`);
        lines.push('');
        return lines.join('\n');
    }
    for (const finding of top) {
        const loc = finding.locations?.[0]?.line ? `:${finding.locations[0].line}` : '';
        lines.push(`- [${finding.severity.toUpperCase()}] ${finding.file}${loc} — ${finding.title}`);
    }
    lines.push('');
    return lines.join('\n');
}
export class SessionStore {
    async init() {
        await ensureDir(SESSIONS_DIR);
    }
    async saveCompleteSession(result) {
        await this.init();
        const sessionDir = getSessionDir(result.sessionId);
        await ensureDir(sessionDir);
        // Write diagrams as .mmd files for easy reuse.
        const diagramsDir = getSessionDiagramsDir(result.sessionId);
        await ensureDir(diagramsDir);
        for (const diagram of result.diagrams) {
            const safeName = diagram.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const diagramPath = path.join(diagramsDir, `${safeName}.mmd`);
            await fs.writeFile(diagramPath, diagram.mermaid, 'utf-8');
        }
        const summary = buildSummaryMarkdown(result);
        await fs.writeFile(getSessionSummaryPath(result.sessionId), summary, 'utf-8');
        // Meta for session listing / quick resume.
        const meta = {
            sessionId: result.sessionId,
            repoUrl: result.repoUrl,
            normalizedRepoUrl: result.normalizedRepoUrl,
            commitHash: result.commitHash,
            createdAt: result.createdAt,
            completedAt: result.completedAt,
            status: result.error ? 'error' : 'complete',
            filesAnalyzed: result.analysis.analyzedFiles,
            findings: {
                critical: result.analysis.findingsBySeverity.critical.length,
                high: result.analysis.findingsBySeverity.high.length,
                medium: result.analysis.findingsBySeverity.medium.length,
                low: result.analysis.findingsBySeverity.low.length,
                total: result.analysis.totalFindings,
            },
            patchesGenerated: result.patches.length,
            diagrams: result.diagrams.map(d => d.name),
        };
        await writeJson(getSessionMetaPath(result.sessionId), meta);
        await writeJson(getSessionResultPath(result.sessionId), result);
        logger.info({ sessionId: result.sessionId, sessionDir }, 'Saved session to disk');
    }
    async loadSessionResult(sessionId) {
        return readJson(getSessionResultPath(sessionId));
    }
    async loadSessionMeta(sessionId) {
        return readJson(getSessionMetaPath(sessionId));
    }
    async listSessions(limit = 20) {
        await this.init();
        try {
            const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
            const metas = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const meta = await this.loadSessionMeta(entry.name);
                if (meta)
                    metas.push(meta);
            }
            metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            return metas.slice(0, limit);
        }
        catch {
            return [];
        }
    }
}
export const sessionStore = new SessionStore();
