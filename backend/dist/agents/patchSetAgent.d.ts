/**
 * Patch Set Agent
 * Generates a multi-file patch plan (including new files) to remediate findings.
 *
 * IMPORTANT: This is proposal-only. Nothing is written until the user explicitly applies it.
 */
export type PatchOperation = {
    action: 'modify' | 'add';
    path: string;
    content: string;
};
export type PatchSet = {
    operations: PatchOperation[];
    changes: string[];
    explanation: string;
};
export declare class PatchSetAgent {
    private agent;
    constructor(model?: string);
    generatePatchSet(params: {
        repoUrl: string;
        fileTree: string[];
        packageJson?: string | null;
        targetFile: {
            path: string;
            content: string;
        };
        nearbyFiles?: Array<{
            path: string;
            content: string;
        }>;
        findings: Array<{
            id: string;
            ruleId: string;
            severity: string;
            title: string;
            issue: string;
            remediation: string;
            locations: Array<{
                line: number;
                endLine?: number;
                code?: string;
            }>;
        }>;
        validationErrors?: string[];
    }): Promise<PatchSet | null>;
    private parsePatchSet;
}
export declare const patchSetAgent: PatchSetAgent;
