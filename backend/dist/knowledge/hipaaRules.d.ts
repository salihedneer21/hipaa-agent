/**
 * HIPAA Compliance Rules Knowledge Base
 * Based on HIPAA Security Rule (45 CFR Part 160 and Part 164)
 */
export interface HIPAARule {
    name: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    patterns: string[];
    remediation: string;
    whyItMatters: string;
    howItHappens: string;
    properFix: string;
    hipaaReference: string;
}
export declare const HIPAA_RULES: Record<string, HIPAARule>;
export declare const ANALYZABLE_EXTENSIONS: string[];
export declare const SKIP_DIRECTORIES: string[];
