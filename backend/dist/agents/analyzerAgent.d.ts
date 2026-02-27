/**
 * HIPAA Analyzer Agent
 * Analyzes source code for HIPAA compliance violations using Claude
 */
import { RepoFile } from '../services/githubService.js';
export interface Finding {
    ruleId: string;
    ruleName: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line: number;
    code?: string;
    issue: string;
    remediation: string;
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
    private client;
    private model;
    constructor(model?: string);
    private quickScan;
    private isCriticalFile;
    analyzeFile(filePath: string, content: string): Promise<Finding[]>;
    private deepAnalyze;
    private parseFindings;
    analyzeRepository(files: RepoFile[]): Promise<AnalysisResult>;
}
export declare const analyzerAgent: AnalyzerAgent;
