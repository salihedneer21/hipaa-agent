export type GitHubRepo = {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch?: string;
    owner?: {
        login: string;
        type?: 'User' | 'Organization';
    };
};
export type GitHubInstallationInfo = {
    id: number;
    account?: {
        login: string;
        type?: 'User' | 'Organization';
    };
    repository_selection?: 'all' | 'selected';
    permissions?: Record<string, string>;
};
type StatePayload = {
    v: 1;
    clientId: string;
    redirectPath: string;
    iat: number;
};
export declare class GitHubAppService {
    isConfigured(): boolean;
    getAppSlugOrNull(): string | null;
    createInstallUrl(clientId: string, redirectPath: string): string;
    verifyInstallState(token: string): StatePayload | null;
    createAppJwt(): Promise<string>;
    getInstallation(installationId: number): Promise<GitHubInstallationInfo>;
    createInstallationAccessToken(installationId: number): Promise<{
        token: string;
        expiresAt: string;
    }>;
    listInstallationRepositories(installationId: number): Promise<GitHubRepo[]>;
    getRepo(owner: string, repo: string, installationId: number): Promise<GitHubRepo>;
    createPullRequest(params: {
        installationId: number;
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
    }): Promise<{
        number: number;
        html_url: string;
    }>;
}
export declare const githubAppService: GitHubAppService;
export {};
