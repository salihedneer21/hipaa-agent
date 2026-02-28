import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { getClientGitHubInstallationsPath } from '../utils/storagePaths.js';

export type StoredGitHubInstallation = {
  installationId: number;
  accountLogin?: string;
  accountType?: 'User' | 'Organization';
  repositorySelection?: 'all' | 'selected';
  permissions?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type InstallationsFile = {
  installations: StoredGitHubInstallation[];
};

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export class GitHubInstallationsStore {
  async listInstallations(clientId: string): Promise<StoredGitHubInstallation[]> {
    const filePath = getClientGitHubInstallationsPath(clientId);
    const existing = await readJson<InstallationsFile>(filePath);
    if (!existing?.installations) return [];
    return existing.installations
      .filter((i): i is StoredGitHubInstallation => Boolean(i) && typeof i.installationId === 'number')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getInstallation(clientId: string, installationId: number): Promise<StoredGitHubInstallation | null> {
    const all = await this.listInstallations(clientId);
    return all.find(i => i.installationId === installationId) || null;
  }

  async upsertInstallation(clientId: string, installation: Omit<StoredGitHubInstallation, 'createdAt' | 'updatedAt'> & Partial<Pick<StoredGitHubInstallation, 'createdAt' | 'updatedAt'>>): Promise<void> {
    const filePath = getClientGitHubInstallationsPath(clientId);
    const now = new Date().toISOString();
    const existing = await readJson<InstallationsFile>(filePath);
    const installations: StoredGitHubInstallation[] = Array.isArray(existing?.installations) ? existing!.installations : [];

    const idx = installations.findIndex(i => i.installationId === installation.installationId);
    if (idx >= 0) {
      const prev = installations[idx]!;
      installations[idx] = {
        ...prev,
        ...installation,
        createdAt: prev.createdAt || installation.createdAt || now,
        updatedAt: installation.updatedAt || now,
      };
    } else {
      installations.push({
        ...installation,
        createdAt: installation.createdAt || now,
        updatedAt: installation.updatedAt || now,
      } as StoredGitHubInstallation);
    }

    await writeJson(filePath, { installations });
    logger.info({ clientId, installationId: installation.installationId }, 'Saved GitHub installation');
  }
}

export const githubInstallationsStore = new GitHubInstallationsStore();

