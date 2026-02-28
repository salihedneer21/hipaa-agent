export interface StoredDiagram {
    name: string;
    title: string;
    mermaid: string;
    findingId?: string;
}
export interface StoredPatch {
    file: string;
    action?: 'modify' | 'add';
    patchSetId?: string;
    originalContent: string;
    patchedContent: string;
    changes: string[];
    explanation: string;
    generatedAt: string;
    appliedAt?: string;
}
export interface StoredAnalysisFinding {
    id: string;
    ruleId: string;
    ruleName: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    title: string;
    issue: string;
    remediation: string;
    locations: Array<{
        line: number;
        endLine?: number;
        code?: string;
    }>;
    whyItMatters?: string;
    howItHappens?: string;
    properFix?: string;
    hipaaReference?: string;
    confidence?: 'high' | 'medium' | 'low';
}
export interface StoredAnalysisResult {
    totalFiles: number;
    analyzedFiles: number;
    totalFindings: number;
    findingsBySeverity: {
        critical: StoredAnalysisFinding[];
        high: StoredAnalysisFinding[];
        medium: StoredAnalysisFinding[];
        low: StoredAnalysisFinding[];
    };
    allFindings: StoredAnalysisFinding[];
}
export interface SessionMeta {
    sessionId: string;
    repoUrl: string;
    normalizedRepoUrl: string;
    commitHash?: string;
    createdAt: string;
    completedAt?: string;
    status: 'complete' | 'error';
    filesAnalyzed: number;
    findings: {
        critical: number;
        high: number;
        medium: number;
        low: number;
        total: number;
    };
    patchesGenerated: number;
    diagrams: string[];
}
export interface SessionResult {
    sessionId: string;
    repoUrl: string;
    normalizedRepoUrl: string;
    commitHash?: string;
    createdAt: string;
    completedAt?: string;
    readme: string | null;
    fileTree: string[];
    analysis: StoredAnalysisResult;
    patches: StoredPatch[];
    diagrams: StoredDiagram[];
    error?: string;
}
export declare class SessionStore {
    init(): Promise<void>;
    saveCompleteSession(result: SessionResult): Promise<void>;
    loadSessionResult(sessionId: string): Promise<SessionResult | null>;
    loadSessionMeta(sessionId: string): Promise<SessionMeta | null>;
    listSessions(limit?: number): Promise<SessionMeta[]>;
}
export declare const sessionStore: SessionStore;
