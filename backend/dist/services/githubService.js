/**
 * GitHub Repository Service
 * Clones and extracts code from GitHub repositories
 */
import simpleGit from 'simple-git';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { ANALYZABLE_EXTENSIONS, SKIP_DIRECTORIES } from '../knowledge/hipaaRules.js';
export class GitHubService {
    tempDir = null;
    async cloneRepo(repoUrl) {
        // Normalize URL
        if (!repoUrl.startsWith('http')) {
            repoUrl = `https://github.com/${repoUrl}`;
        }
        // Create temp directory
        const tempBase = path.join(os.tmpdir(), 'hipaa-analysis');
        await fs.mkdir(tempBase, { recursive: true });
        this.tempDir = path.join(tempBase, uuidv4());
        await fs.mkdir(this.tempDir, { recursive: true });
        const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
        const clonePath = path.join(this.tempDir, repoName);
        const git = simpleGit();
        await git.clone(repoUrl, clonePath, ['--depth', '1']);
        return clonePath;
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
    async fetchRepoForAnalysis(repoUrl) {
        const repoPath = await this.cloneRepo(repoUrl);
        const fileTree = await this.getFileTree(repoPath);
        const readme = await this.getReadme(repoPath);
        // Read all files
        const files = [];
        for (const filePath of fileTree) {
            const content = await this.readFile(repoPath, filePath);
            if (content) {
                files.push({ path: filePath, content });
            }
        }
        return { repoPath, files, readme, fileTree };
    }
    async cleanup() {
        if (this.tempDir) {
            try {
                await fs.rm(this.tempDir, { recursive: true, force: true });
            }
            catch {
                // Ignore cleanup errors
            }
            this.tempDir = null;
        }
    }
}
export const githubService = new GitHubService();
