export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface FindingLocation {
  line: number;
  endLine?: number;
  code?: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
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
  integrations?: string[];
}

export interface ResolvedFinding extends Finding {
  resolvedAt: string;
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

export interface Patch {
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

export interface Diagram {
  name: string;
  title: string;
  mermaid: string;
  findingId?: string;
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
  findings: { critical: number; high: number; medium: number; low: number; total: number };
  patchesGenerated: number;
  diagrams: string[];
}

export interface AnalysisResponse {
  sessionId: string;
  repoUrl: string;
  normalizedRepoUrl: string;
  commitHash?: string;
  github?: { installationId: number; repoFullName: string } | undefined;
  createdAt: string;
  completedAt?: string;
  readme: string | null;
  fileTree: string[];
  analysis: AnalysisResult;
  resolvedFindings?: ResolvedFinding[];
  patches: Patch[];
  diagrams: Diagram[];
  thirdPartyServices?: ThirdPartyService[];
  error?: string;
}

export type ThirdPartyBaaAvailability = 'yes' | 'no' | 'partial' | 'unknown';
export type ThirdPartyBaaConfirmationStatus = 'unknown' | 'confirmed' | 'not_confirmed';

export interface ThirdPartyServiceEvidence {
  kind: string;
  value: string;
  file: string;
}

export interface ThirdPartyBaaResearch {
  availability: ThirdPartyBaaAvailability;
  summary: string;
  howToGetBaa?: string;
  pricing?: string;
  docsUrl?: string;
  sources?: string[];
  researchedAt: string;
}

export interface ThirdPartyService {
  id: string;
  name: string;
  domain?: string;
  category?: string;
  logoUrl?: string;
  evidence?: ThirdPartyServiceEvidence[];
  baa?: ThirdPartyBaaResearch;
  confirmation?: { status: ThirdPartyBaaConfirmationStatus; updatedAt?: string };
}

export interface SessionStatus {
  status: 'pending' | 'analyzing' | 'patching' | 'complete' | 'error';
  progress: number;
  message: string;
  createdAt?: string;
  currentFile?: string;
  totalFiles?: number;
  analyzedFiles?: number;
  issuesPreview?: Array<{ id: string; severity: Severity; file: string; line: number; title: string }>;
  result?: AnalysisResponse;
  error?: string;
}
