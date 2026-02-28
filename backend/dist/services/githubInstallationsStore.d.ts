export type StoredGitHubInstallation = {
    installationId: number;
    accountLogin?: string;
    accountType?: 'User' | 'Organization';
    repositorySelection?: 'all' | 'selected';
    permissions?: Record<string, string>;
    createdAt: string;
    updatedAt: string;
};
export declare class GitHubInstallationsStore {
    listInstallations(clientId: string): Promise<StoredGitHubInstallation[]>;
    getInstallation(clientId: string, installationId: number): Promise<StoredGitHubInstallation | null>;
    upsertInstallation(clientId: string, installation: Omit<StoredGitHubInstallation, 'createdAt' | 'updatedAt'> & Partial<Pick<StoredGitHubInstallation, 'createdAt' | 'updatedAt'>>): Promise<void>;
}
export declare const githubInstallationsStore: GitHubInstallationsStore;
