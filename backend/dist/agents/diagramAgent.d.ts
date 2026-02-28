/**
 * Diagram Agent
 * Generates Mermaid diagrams (architecture + data flow) for easier system understanding
 */
export interface MermaidDiagram {
    name: string;
    title: string;
    mermaid: string;
}
export declare class DiagramAgent {
    private agent;
    constructor(model?: string);
    generateDiagrams(params: {
        repoUrl: string;
        readme: string | null;
        fileTree: string[];
        keyFiles: Array<{
            path: string;
            content: string;
        }>;
        findingsSummary: string;
    }): Promise<MermaidDiagram[]>;
    generateFindingDiagram(params: {
        repoUrl: string;
        readme: string | null;
        fileTree: string[];
        finding: {
            id: string;
            file: string;
            severity: string;
            title: string;
            issue: string;
            remediation: string;
            whyItMatters?: string;
            howItHappens?: string;
            properFix?: string;
            locations: Array<{
                line: number;
                endLine?: number;
                code?: string;
            }>;
        };
        fileContent: string;
    }): Promise<MermaidDiagram>;
    private parseDiagrams;
    private parseSingleDiagram;
}
export declare const diagramAgent: DiagramAgent;
