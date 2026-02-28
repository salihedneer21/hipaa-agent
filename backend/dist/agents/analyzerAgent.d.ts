/**
 * HIPAA Analyzer Agent
 * Analyzes source code for HIPAA compliance violations using OpenAI Agents SDK
 */
export interface FindingLocation {
    line: number;
    endLine?: number;
    code?: string;
}
export interface Finding {
    id: string;
    ruleId: string;
    ruleName: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    title: string;
    issue: string;
    remediation: string;
    locations: FindingLocation[];
    whyItMatters?: string;
    howItHappens?: string;
    properFix?: string;
    hipaaReference?: string;
    confidence?: 'high' | 'medium' | 'low';
}
export interface AnalysisResult {
    totalFiles: number;
    analyzedFiles: number;
    totalFindings: number;
    findingsBySeverity: {
        critical: Finding[];
        high: Finding[];
        medium: Finding[];
        low: Finding[];
    };
    allFindings: Finding[];
}
export declare class AnalyzerAgent {
    private agent;
    constructor(model?: string);
    private isCriticalFile;
    private quickSignal;
    private formatCodeWithLineNumbers;
    private normalizeForKey;
    private computeFindingId;
    analyzeFile(filePath: string, content: string, options?: {
        force?: boolean;
    }): Promise<Finding[]>;
    private deepAnalyze;
    private parseFindings;
    buildAnalysisResult(totalFiles: number, analyzedFiles: number, allFindings: Finding[]): AnalysisResult;
}
export declare const analyzerAgent: AnalyzerAgent;
