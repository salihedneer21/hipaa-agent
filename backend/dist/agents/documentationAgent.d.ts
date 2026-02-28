/**
 * Documentation Agent
 * Generates project documentation using OpenAI Agents SDK
 */
import { RepoFile } from '../services/githubService.js';
export interface ProjectDocumentation {
    overview: string;
    techStack: {
        languages: string[];
        frameworks: string[];
        dependencies: Array<{
            name: string;
            version: string;
            purpose: string;
        }>;
    };
    architecture: {
        structure: string;
        modules: Array<{
            name: string;
            path: string;
            description: string;
            responsibilities: string[];
        }>;
    };
    businessContext: {
        purpose: string;
        targetUsers: string;
        keyFeatures: string[];
        dataHandled: string[];
    };
    securityNotes: string[];
    generatedAt: string;
}
export declare class DocumentationAgent {
    private agent;
    constructor(model?: string);
    generateDocumentation(files: RepoFile[], readme: string | null): Promise<ProjectDocumentation>;
    private parseDocumentation;
    private getDefaultDocumentation;
}
export declare const documentationAgent: DocumentationAgent;
