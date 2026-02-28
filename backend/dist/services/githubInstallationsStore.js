import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { getClientGitHubInstallationsPath } from '../utils/storagePaths.js';
async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
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
async function writeJson(filePath, data) {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
export class GitHubInstallationsStore {
    async listInstallations(clientId) {
        const filePath = getClientGitHubInstallationsPath(clientId);
        const existing = await readJson(filePath);
        if (!existing?.installations)
            return [];
        return existing.installations
            .filter((i) => Boolean(i) && typeof i.installationId === 'number')
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    async getInstallation(clientId, installationId) {
        const all = await this.listInstallations(clientId);
        return all.find(i => i.installationId === installationId) || null;
    }
    async upsertInstallation(clientId, installation) {
        const filePath = getClientGitHubInstallationsPath(clientId);
        const now = new Date().toISOString();
        const existing = await readJson(filePath);
        const installations = Array.isArray(existing?.installations) ? existing.installations : [];
        const idx = installations.findIndex(i => i.installationId === installation.installationId);
        if (idx >= 0) {
            const prev = installations[idx];
            installations[idx] = {
                ...prev,
                ...installation,
                createdAt: prev.createdAt || installation.createdAt || now,
                updatedAt: installation.updatedAt || now,
            };
        }
        else {
            installations.push({
                ...installation,
                createdAt: installation.createdAt || now,
                updatedAt: installation.updatedAt || now,
            });
        }
        await writeJson(filePath, { installations });
        logger.info({ clientId, installationId: installation.installationId }, 'Saved GitHub installation');
    }
}
export const githubInstallationsStore = new GitHubInstallationsStore();
