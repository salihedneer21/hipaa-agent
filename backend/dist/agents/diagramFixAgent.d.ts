/**
 * Diagram Fix Agent
 * Repairs invalid Mermaid diagrams based on a render/parse error.
 */
export declare class DiagramFixAgent {
    private agent;
    constructor(model?: string);
    fixMermaid(params: {
        mermaid: string;
        error: string;
        context?: string;
    }): Promise<string | null>;
}
export declare const diagramFixAgent: DiagramFixAgent;
