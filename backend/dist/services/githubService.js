/**
 * Repository Service
 * Clones and reads source from Git repositories (GitHub URLs supported)
 */
import { simpleGit } from 'simple-git';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { ANALYZABLE_EXTENSIONS, SKIP_DIRECTORIES } from '../knowledge/hipaaRules.js';
import { getSessionRepoDir } from '../utils/storagePaths.js';
export class GitHubService {
    async runGit(args, options = {}) {
        return new Promise((resolve) => {
            const child = spawn('git', args, {
                cwd: options.cwd,
                env: {
                    ...process.env,
                    ...(options.env || {}),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('close', (code) => resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 }));
            child.on('error', () => resolve({ stdout, stderr: stderr || 'Failed to start git process', code: 1 }));
        });
    }
    resolveLocalRepoPath(repoUrl) {
        const raw = (repoUrl || '').trim();
        if (!raw)
            return null;
        // file:// URLs
        if (raw.startsWith('file:')) {
            try {
                return fileURLToPath(raw);
            }
            catch {
                return null;
            }
        }
        // Home-relative paths
        if (raw === '~')
            return os.homedir();
        if (raw.startsWith('~/'))
            return path.join(os.homedir(), raw.slice(2));
        // Absolute or relative filesystem paths
        if (path.isAbsolute(raw) || raw.startsWith('./') || raw.startsWith('../')) {
            return path.resolve(raw);
        }
        // Windows drive path (best-effort)
        if (/^[A-Za-z]:[\\/]/.test(raw)) {
            return path.resolve(raw);
        }
        return null;
    }
    normalizeRepoUrl(repoUrl) {
        const local = this.resolveLocalRepoPath(repoUrl);
        if (local) {
            try {
                return pathToFileURL(local).toString();
            }
            catch {
                return local;
            }
        }
        if (!repoUrl.startsWith('http')) {
            return `https://github.com/${repoUrl}`;
        }
        return repoUrl;
    }
    async cloneRepoToSession(sessionId, repoUrl) {
        const normalizedRepoUrl = this.normalizeRepoUrl(repoUrl);
        const clonePath = getSessionRepoDir(sessionId);
        // Ensure clean destination (a sessionId should be unique, but be defensive).
        await fs.rm(clonePath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(clonePath), { recursive: true });
        const git = simpleGit();
        await git.clone(normalizedRepoUrl, clonePath, ['--depth', '1']);
        let commitHash;
        try {
            const repoGit = simpleGit({ baseDir: clonePath });
            commitHash = (await repoGit.revparse(['HEAD'])).trim();
        }
        catch {
            commitHash = undefined;
        }
        return { repoPath: clonePath, normalizedRepoUrl, commitHash };
    }
    async cloneRepoToSessionWithToken(sessionId, repoUrl, token) {
        const normalizedRepoUrl = this.normalizeRepoUrl(repoUrl);
        const clonePath = getSessionRepoDir(sessionId);
        await fs.rm(clonePath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(clonePath), { recursive: true });
        const askpassPath = path.join(path.dirname(clonePath), `.git-askpass_${Date.now()}_${Math.random().toString(16).slice(2)}`);
        const askpassScript = `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "$HIPAA_AGENT_GIT_TOKEN" ;;
  *) echo "$HIPAA_AGENT_GIT_TOKEN" ;;
esac
`;
        await fs.writeFile(askpassPath, askpassScript, { encoding: 'utf-8', mode: 0o700 });
        try {
            const env = {
                GIT_TERMINAL_PROMPT: '0',
                GIT_ASKPASS: askpassPath,
                HIPAA_AGENT_GIT_TOKEN: token,
            };
            const cloned = await this.runGit(['clone', '--depth', '1', normalizedRepoUrl, clonePath], { env });
            if (cloned.code !== 0) {
                throw new Error(cloned.stderr || 'git clone failed');
            }
            const rev = await this.runGit(['rev-parse', 'HEAD'], { cwd: clonePath });
            const commitHash = rev.code === 0 ? rev.stdout.trim() : undefined;
            return { repoPath: clonePath, normalizedRepoUrl, commitHash };
        }
        finally {
            await fs.rm(askpassPath, { force: true });
        }
    }
    async copyLocalRepoToSession(sessionId, localRepoPath) {
        const absPath = path.resolve(localRepoPath);
        const stat = await fs.stat(absPath);
        if (!stat.isDirectory()) {
            throw new Error(`Local path is not a directory: ${absPath}`);
        }
        const normalizedRepoUrl = (() => {
            try {
                return pathToFileURL(absPath).toString();
            }
            catch {
                return absPath;
            }
        })();
        const clonePath = getSessionRepoDir(sessionId);
        await fs.rm(clonePath, { recursive: true, force: true });
        await fs.mkdir(clonePath, { recursive: true });
        const fileTree = await this.getFileTree(absPath);
        for (const relPath of fileTree) {
            const from = path.join(absPath, relPath);
            const to = path.join(clonePath, relPath);
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.copyFile(from, to);
        }
        const readme = await this.getReadme(absPath);
        let commitHash;
        try {
            const repoGit = simpleGit({ baseDir: absPath });
            commitHash = (await repoGit.revparse(['HEAD'])).trim();
        }
        catch {
            commitHash = undefined;
        }
        return { repoPath: clonePath, normalizedRepoUrl, commitHash, fileTree, readme };
    }
    async getFileTree(repoPath) {
        const files = [];
        const walk = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(repoPath, fullPath);
                // Skip hidden files and directories
                if (entry.name.startsWith('.'))
                    continue;
                // Skip common non-code directories
                if (SKIP_DIRECTORIES.some(skip => relativePath.includes(skip)))
                    continue;
                if (entry.isDirectory()) {
                    await walk(fullPath);
                }
                else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (ANALYZABLE_EXTENSIONS.includes(ext) || entry.name === '.env') {
                        files.push(relativePath);
                    }
                }
            }
        };
        await walk(repoPath);
        return files.sort();
    }
    async readFile(repoPath, filePath) {
        const fullPath = path.join(repoPath, filePath);
        try {
            return await fs.readFile(fullPath, 'utf-8');
        }
        catch {
            return '';
        }
    }
    async readFilePreview(repoPath, filePath, maxBytes) {
        const fullPath = path.join(repoPath, filePath);
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            return { content: await this.readFile(repoPath, filePath), truncated: false };
        }
        try {
            const handle = await fs.open(fullPath, 'r');
            try {
                const buffer = Buffer.alloc(Math.min(maxBytes, 512_000));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                const stat = await fs.stat(fullPath);
                return {
                    content: buffer.subarray(0, bytesRead).toString('utf-8'),
                    truncated: stat.size > bytesRead,
                };
            }
            finally {
                await handle.close();
            }
        }
        catch {
            return { content: '', truncated: false };
        }
    }
    async writeFile(repoPath, filePath, content) {
        const fullPath = path.join(repoPath, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
    }
    async getReadme(repoPath) {
        const readmeNames = ['README.md', 'README.rst', 'README.txt', 'README'];
        for (const name of readmeNames) {
            try {
                const content = await fs.readFile(path.join(repoPath, name), 'utf-8');
                return content;
            }
            catch {
                continue;
            }
        }
        return null;
    }
    async fetchRepoForAnalysis(sessionId, repoUrl, options) {
        const local = this.resolveLocalRepoPath(repoUrl);
        if (local) {
            const localResult = await this.copyLocalRepoToSession(sessionId, local);
            return {
                repoPath: localResult.repoPath,
                readme: localResult.readme,
                fileTree: localResult.fileTree,
                normalizedRepoUrl: localResult.normalizedRepoUrl,
                commitHash: localResult.commitHash,
            };
        }
        const authToken = options?.authToken;
        const { repoPath, normalizedRepoUrl, commitHash } = authToken
            ? await this.cloneRepoToSessionWithToken(sessionId, repoUrl, authToken)
            : await this.cloneRepoToSession(sessionId, repoUrl);
        const fileTree = await this.getFileTree(repoPath);
        const readme = await this.getReadme(repoPath);
        return { repoPath, readme, fileTree, normalizedRepoUrl, commitHash };
    }
}
export const githubService = new GitHubService();
