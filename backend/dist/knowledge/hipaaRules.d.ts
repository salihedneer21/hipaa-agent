/**
 * HIPAA Compliance Rules Knowledge Base
 *
 * POC scope:
 * - Notifications & Communications
 * - Authentication & Access Control
 * - Client-Side Data Storage
 * - Light audit logging
 *
 * Note: These "rules" are used as hints for the analyzer to focus on files that are
 * likely relevant. Final determinations are made by the analyzer with full code context.
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
