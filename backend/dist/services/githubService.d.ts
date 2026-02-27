/**
 * GitHub Repository Service
 * Clones and extracts code from GitHub repositories
 */
export interface RepoFile {
    path: string;
    content: string;
}
export interface RepoData {
    repoPath: string;
    files: RepoFile[];
    readme: string | null;
    fileTree: string[];
}
export declare class GitHubService {
    private tempDir;
    cloneRepo(repoUrl: string): Promise<string>;
    getFileTree(repoPath: string): Promise<string[]>;
    readFile(repoPath: string, filePath: string): Promise<string>;
    getReadme(repoPath: string): Promise<string | null>;
    fetchRepoForAnalysis(repoUrl: string): Promise<RepoData>;
    cleanup(): Promise<void>;
}
export declare const githubService: GitHubService;
