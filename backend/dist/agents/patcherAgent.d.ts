/**
 * Security Patcher Agent
 * Generates patches for HIPAA compliance issues using OpenAI Agents SDK
 */
import { Finding, AnalysisResult } from './analyzerAgent.js';
import { RepoFile } from '../services/githubService.js';
export interface Patch {
    file: string;
    originalContent: string;
    patchedContent: string | null;
    changes: string[];
    explanation: string;
    error?: string;
}
export interface PatchResult {
    totalFiles: number;
    patchesGenerated: number;
    patches: Patch[];
}
export declare class PatcherAgent {
    private agent;
    constructor(model?: string);
    generatePatch(filePath: string, content: string, findings: Finding[]): Promise<Patch>;
    private parsePatchResponse;
    generatePatchesForRepo(files: RepoFile[], analysisResult: AnalysisResult): Promise<PatchResult>;
}
export declare const patcherAgent: PatcherAgent;
