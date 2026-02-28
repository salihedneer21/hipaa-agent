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
export type StoredThirdPartyBaaAvailability = 'yes' | 'no' | 'partial' | 'unknown';
export type StoredThirdPartyBaaConfirmationStatus = 'unknown' | 'confirmed' | 'not_confirmed';
export interface StoredThirdPartyService {
    id: string;
    name: string;
    domain?: string;
    category?: string;
    logoUrl?: string;
    evidence?: Array<{
        kind: string;
        value: string;
        file: string;
    }>;
    baa?: {
        availability: StoredThirdPartyBaaAvailability;
        summary: string;
        howToGetBaa?: string;
        pricing?: string;
        docsUrl?: string;
        sources?: string[];
        researchedAt: string;
    };
    confirmation?: {
        status: StoredThirdPartyBaaConfirmationStatus;
        updatedAt?: string;
    };
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
    integrations?: string[];
}
export interface StoredResolvedFinding extends StoredAnalysisFinding {
    resolvedAt: string;
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
    github?: {
        installationId: number;
        repoFullName: string;
    } | undefined;
    createdAt: string;
    completedAt?: string;
    readme: string | null;
    fileTree: string[];
    analysis: StoredAnalysisResult;
    resolvedFindings?: StoredResolvedFinding[];
    patches: StoredPatch[];
    diagrams: StoredDiagram[];
    thirdPartyServices?: StoredThirdPartyService[];
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
