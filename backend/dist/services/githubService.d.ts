/**
 * Repository Service
 * Clones and reads source from Git repositories (GitHub URLs supported)
 */
export interface RepoFile {
    path: string;
    content: string;
}
export interface RepoData {
    repoPath: string;
    readme: string | null;
    fileTree: string[];
    normalizedRepoUrl: string;
    commitHash?: string;
}
export declare class GitHubService {
    private resolveLocalRepoPath;
    normalizeRepoUrl(repoUrl: string): string;
    cloneRepoToSession(sessionId: string, repoUrl: string): Promise<{
        repoPath: string;
        normalizedRepoUrl: string;
        commitHash?: string;
    }>;
    private copyLocalRepoToSession;
    getFileTree(repoPath: string): Promise<string[]>;
    readFile(repoPath: string, filePath: string): Promise<string>;
    readFilePreview(repoPath: string, filePath: string, maxBytes: number): Promise<{
        content: string;
        truncated: boolean;
    }>;
    writeFile(repoPath: string, filePath: string, content: string): Promise<void>;
    getReadme(repoPath: string): Promise<string | null>;
    fetchRepoForAnalysis(sessionId: string, repoUrl: string): Promise<RepoData>;
}
export declare const githubService: GitHubService;
