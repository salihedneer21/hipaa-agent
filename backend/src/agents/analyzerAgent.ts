/**
 * HIPAA Analyzer Agent
 * Analyzes source code for HIPAA compliance violations using OpenAI Agents SDK
 */

import { Agent, run } from '@openai/agents';
import { HIPAA_RULES } from '../knowledge/hipaaRules.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';

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

const SYSTEM_INSTRUCTIONS = `You are a HIPAA compliance security expert analyzing source code.

Your task is to identify potential HIPAA violations in the provided code. Focus on:

1. **PHI Exposure**: Any logging, printing, or exposure of Protected Health Information
2. **Encryption Issues**: Unencrypted storage or transmission of PHI
3. **Access Control**: Missing authentication, hardcoded credentials
4. **Audit Logging**: Missing audit trails for PHI access
5. **Data Integrity**: SQL injection, input validation issues
6. **Session Security**: Missing session timeouts, insecure sessions

For each issue, provide severity (critical/high/medium/low), line number, description, and fix.
Be thorough but avoid false positives.

IMPORTANT:
- Do NOT report one finding per repeated occurrence. Group repeated occurrences into ONE finding with multiple locations.
- Only report issues with clear evidence (do not flag variable names alone as PHI).`;

export class AnalyzerAgent {
  private agent: Agent;

  constructor(model: string = 'gpt-4o') {
    this.agent = new Agent({
      name: 'HIPAA Analyzer',
      instructions: SYSTEM_INSTRUCTIONS,
      model,
    });
  }

  private isCriticalFile(filePath: string): boolean {
    const criticalPatterns = [
      'auth', 'login', 'patient', 'medical', 'health',
      'encrypt', 'security', 'api', 'database', 'config',
      'controller', 'service', 'model', 'route',
    ];
    const lowerPath = filePath.toLowerCase();
    return criticalPatterns.some(p => lowerPath.includes(p));
  }

  private quickSignal(filePath: string, content: string): Array<{ ruleId: string; ruleName: string; severity: string; line: number; snippet: string; pattern: string }> {
    const matches: Array<{ ruleId: string; ruleName: string; severity: string; line: number; snippet: string; pattern: string }> = [];
    const lines = content.split('\n');
    const matchedRuleIds = new Set<string>();

    for (const [ruleId, rule] of Object.entries(HIPAA_RULES)) {
      if (matchedRuleIds.has(ruleId)) continue;
      for (const pattern of rule.patterns) {
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, 'i');
        } catch {
          continue;
        }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (regex.test(line)) {
            matchedRuleIds.add(ruleId);
            matches.push({
              ruleId,
              ruleName: rule.name,
              severity: rule.severity,
              line: i + 1,
              snippet: line.trim().slice(0, 160),
              pattern,
            });
            break;
          }
        }

        if (matchedRuleIds.has(ruleId)) break;
      }
    }

    // Reduce noise: keep at most a few signals.
    matches.sort((a, b) => a.severity.localeCompare(b.severity));
    return matches.slice(0, 8);
  }

  private formatCodeWithLineNumbers(content: string, maxChars: number = 30000): { code: string; truncated: boolean } {
    const lines = content.split('\n');
    const out: string[] = [];
    let used = 0;
    let truncated = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNumber = String(i + 1).padStart(4, ' ');
      const row = `${lineNumber}| ${lines[i]}`;
      used += row.length + 1;
      if (used > maxChars) {
        truncated = true;
        break;
      }
      out.push(row);
    }

    if (truncated) {
      out.push('... [truncated]');
    }

    return { code: out.join('\n'), truncated };
  }

  private normalizeForKey(text: string): string {
    return text
      .toLowerCase()
      .replace(/[`"'’“”]/g, '')
      // Remove explicit line references that often create duplicate keys.
      .replace(/\b(lines?|ln)\s*\d+(\s*-\s*\d+)?\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  private computeFindingId(filePath: string, ruleId: string, title: string, issue: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${filePath}|${ruleId}|${this.normalizeForKey(title)}|${this.normalizeForKey(issue)}`)
      .digest('hex');
    return `finding_${hash.slice(0, 16)}`;
  }

  async analyzeFile(
    filePath: string,
    content: string,
    options?: { force?: boolean }
  ): Promise<Finding[]> {
    const signals = this.quickSignal(filePath, content);
    if (!options?.force) {
      if (signals.length === 0 && !this.isCriticalFile(filePath)) {
        return [];
      }
    }
    return this.deepAnalyze(filePath, content, signals);
  }

  private async deepAnalyze(
    filePath: string,
    content: string,
    signals: Array<{ ruleId: string; ruleName: string; severity: string; line: number; snippet: string; pattern: string }>
  ): Promise<Finding[]> {
    const { code, truncated } = this.formatCodeWithLineNumbers(content, 30000);

    const ruleIds = Object.keys(HIPAA_RULES);
    const rulesSummary = ruleIds
      .map(ruleId => {
        const rule = HIPAA_RULES[ruleId]!;
        return `- ${ruleId}: ${rule.name} (${rule.severity}) — ${rule.description}`;
      })
      .join('\n');

    const signalsSummary = signals.length > 0
      ? signals.map(s => `- [${s.severity}] ${s.ruleId} @ line ${s.line}: ${s.snippet}`).join('\n')
      : '(No pattern signals; file analyzed because it looks security-sensitive)';

    const prompt = `Analyze this file for HIPAA compliance issues.

File: ${filePath}
Truncated: ${truncated ? 'yes' : 'no'}

Pre-scan signals (hints only; may include false positives):
${signalsSummary}

Use ONLY these ruleIds when possible (otherwise use "other"):
${rulesSummary}

Return STRICT JSON only (no markdown, no code fences) matching:
{
  "findings": [
    {
      "ruleId": "phi_exposure|encryption_at_rest|encryption_in_transit|access_control|audit_logging|sql_injection|xss_vulnerability|session_management|error_handling|third_party|other",
      "severity": "critical|high|medium|low",
      "title": "Short, specific title",
      "issue": "What is wrong and where",
      "remediation": "Short fix summary",
      "whyItMatters": "Why this matters for HIPAA/security",
      "howItHappens": "How this issue typically occurs",
      "properFix": "Concrete fix steps / code-level guidance",
      "hipaaReference": "Optional CFR reference if applicable",
      "confidence": "high|medium|low",
      "locations": [
        { "line": 12, "endLine": 12 }
      ]
    }
  ]
}

Rules:
- Do NOT output duplicates. If the same issue appears multiple times, create ONE finding with multiple locations.
- Only output findings with clear evidence in code. Do not flag variable names alone as PHI exposure.

Code (line-numbered):
\`\`\`
${code}
\`\`\``;

    try {
      logger.debug({ file: filePath }, 'Starting deep analysis with OpenAI');
      const result = await run(this.agent, prompt);
      logger.debug({ file: filePath, hasOutput: !!result.finalOutput }, 'Deep analysis complete');
      const text = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '');
      return this.parseFindings(filePath, content, text);
    } catch (error: any) {
      logger.error({
        err: error,
        file: filePath,
        message: error?.message,
        stack: error?.stack
      }, 'Deep analysis failed');
      return [];
    }
  }

  private parseFindings(filePath: string, originalContent: string, response: string): Finding[] {
    const extractJson = (text: string): string | null => {
      const fence = text.match(/```json\s*([\s\S]*?)```/i);
      const candidate = fence ? fence[1] : text;
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start >= 0 && end > start) return candidate.slice(start, end + 1);
      return null;
    };

    const jsonText = extractJson(response);
    if (!jsonText) return [];

    type RawFinding = {
      ruleId?: string;
      severity?: string;
      title?: string;
      issue?: string;
      remediation?: string;
      whyItMatters?: string;
      howItHappens?: string;
      properFix?: string;
      hipaaReference?: string;
      confidence?: string;
      locations?: Array<{ line?: number; endLine?: number }>;
    };

    let parsed: { findings?: RawFinding[] } | null = null;
    try {
      parsed = JSON.parse(jsonText) as { findings?: RawFinding[] };
    } catch {
      logger.debug({ file: filePath }, 'Failed to parse analyzer JSON response');
      return [];
    }

    const lines = originalContent.split('\n');

    const findings: Finding[] = [];
    for (const raw of parsed.findings || []) {
      const ruleId = typeof raw.ruleId === 'string' ? raw.ruleId : 'other';
      const rule = HIPAA_RULES[ruleId];
      const ruleName = rule?.name || 'Security Finding';

      const severityRaw = typeof raw.severity === 'string' ? raw.severity.toLowerCase() : (rule?.severity || 'medium');
      const severity: Finding['severity'] =
        severityRaw === 'critical' || severityRaw === 'high' || severityRaw === 'medium' || severityRaw === 'low'
          ? (severityRaw as Finding['severity'])
          : (rule?.severity || 'medium');

      const title = (typeof raw.title === 'string' && raw.title.trim()) ? raw.title.trim() : ruleName;
      const issue = (typeof raw.issue === 'string' && raw.issue.trim()) ? raw.issue.trim() : 'Potential HIPAA compliance issue detected';
      const remediation = (typeof raw.remediation === 'string' && raw.remediation.trim()) ? raw.remediation.trim() : (rule?.remediation || 'See HIPAA guidelines');

      const rawLocations = Array.isArray(raw.locations) ? raw.locations : [];
      const locations: FindingLocation[] = rawLocations
        .map((loc): FindingLocation | null => {
          const line = Number(loc.line || 0);
          const endLine = loc.endLine ? Number(loc.endLine) : undefined;
          if (!Number.isFinite(line) || line <= 0) return null;
          const code = lines[line - 1]?.trim().slice(0, 200);
          const location: FindingLocation = { line, code };
          if (endLine && endLine >= line) location.endLine = endLine;
          return location;
        })
        .filter((x): x is FindingLocation => x !== null);

      if (locations.length === 0) continue;

      findings.push({
        id: this.computeFindingId(filePath, ruleId, title, issue),
        ruleId,
        ruleName,
        severity,
        file: filePath,
        title,
        issue,
        remediation,
        locations,
        whyItMatters: typeof raw.whyItMatters === 'string' ? raw.whyItMatters.trim() : rule?.whyItMatters,
        howItHappens: typeof raw.howItHappens === 'string' ? raw.howItHappens.trim() : rule?.howItHappens,
        properFix: typeof raw.properFix === 'string' ? raw.properFix.trim() : rule?.properFix,
        hipaaReference: typeof raw.hipaaReference === 'string' ? raw.hipaaReference.trim() : rule?.hipaaReference,
        confidence:
          raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
            ? (raw.confidence as Finding['confidence'])
            : undefined,
      });
    }

    const mergeInto = (target: Finding, incoming: Finding) => {
      const locKeys = new Set(target.locations.map(l => `${l.line}:${l.endLine || l.line}`));
      for (const loc of incoming.locations) {
        const lk = `${loc.line}:${loc.endLine || loc.line}`;
        if (!locKeys.has(lk)) {
          locKeys.add(lk);
          target.locations.push(loc);
          continue;
        }

        // If we already have this location but are missing a snippet, keep the richer code snippet.
        const existingLoc = target.locations.find(l => `${l.line}:${l.endLine || l.line}` === lk);
        if (existingLoc && !existingLoc.code && loc.code) existingLoc.code = loc.code;
      }
      target.locations.sort((a, b) => a.line - b.line);

      const rank = (s: Finding['severity']): number => (s === 'critical' ? 4 : s === 'high' ? 3 : s === 'medium' ? 2 : 1);
      if (rank(incoming.severity) > rank(target.severity)) target.severity = incoming.severity;

      // Prefer richer details where available.
      const pickLongest = (a?: string, b?: string) => {
        const aa = typeof a === 'string' ? a.trim() : '';
        const bb = typeof b === 'string' ? b.trim() : '';
        if (!aa) return bb || undefined;
        if (!bb) return aa || undefined;
        return (bb.length > aa.length ? bb : aa) || undefined;
      };

      target.issue = pickLongest(target.issue, incoming.issue) || target.issue;
      target.remediation = pickLongest(target.remediation, incoming.remediation) || target.remediation;
      target.whyItMatters = pickLongest(target.whyItMatters, incoming.whyItMatters);
      target.howItHappens = pickLongest(target.howItHappens, incoming.howItHappens);
      target.properFix = pickLongest(target.properFix, incoming.properFix);
      target.hipaaReference = pickLongest(target.hipaaReference, incoming.hipaaReference);
      target.confidence = target.confidence || incoming.confidence;
    };

    // Merge duplicates the model might have returned. Prefer grouping by title/issue instead of remediation
    // (models often vary remediation phrasing).
    const merged = new Map<string, Finding>();
    for (const finding of findings) {
      const key = `${finding.file}|${finding.ruleId}|${this.normalizeForKey(finding.title)}|${this.normalizeForKey(finding.issue)}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...finding, locations: [...finding.locations] });
        continue;
      }
      mergeInto(existing, finding);
    }

    let mergedFindings = Array.from(merged.values());

    // If a file explodes into many similar findings under the same ruleId, merge them more aggressively by remediation.
    const MAX_FINDINGS_PER_RULE_PER_FILE = 12;
    const byFileRule = new Map<string, Finding[]>();
    for (const f of mergedFindings) {
      const k = `${f.file}|${f.ruleId}`;
      const arr = byFileRule.get(k) || [];
      arr.push(f);
      byFileRule.set(k, arr);
    }

    const final: Finding[] = [];
    for (const [, group] of byFileRule) {
      if (group.length <= MAX_FINDINGS_PER_RULE_PER_FILE) {
        final.push(...group);
        continue;
      }

      const byRemediation = new Map<string, Finding>();
      for (const f of group) {
        const rk = `${f.file}|${f.ruleId}|${this.normalizeForKey(f.remediation) || this.normalizeForKey(f.title)}`;
        const existing = byRemediation.get(rk);
        if (!existing) {
          byRemediation.set(rk, { ...f, locations: [...f.locations] });
          continue;
        }

        // When collapsing multiple titles, keep the shortest title (usually the most generic) and preserve the richest issue text.
        if (f.title && existing.title && f.title.length < existing.title.length) existing.title = f.title;
        mergeInto(existing, f);
      }

      final.push(...Array.from(byRemediation.values()));
    }

    return final;
  }

  buildAnalysisResult(totalFiles: number, analyzedFiles: number, allFindings: Finding[]): AnalysisResult {
    // Extra safety: de-dupe by finding id across the whole repo (models can occasionally repeat identical findings).
    const rank = (s: Finding['severity']): number => (s === 'critical' ? 4 : s === 'high' ? 3 : s === 'medium' ? 2 : 1);
    const pickLongest = (a?: string, b?: string) => {
      const aa = typeof a === 'string' ? a.trim() : '';
      const bb = typeof b === 'string' ? b.trim() : '';
      if (!aa) return bb || undefined;
      if (!bb) return aa || undefined;
      return (bb.length > aa.length ? bb : aa) || undefined;
    };

    const byId = new Map<string, Finding>();
    for (const f of allFindings) {
      const existing = byId.get(f.id);
      if (!existing) {
        byId.set(f.id, { ...f, locations: [...(f.locations || [])] });
        continue;
      }

      const locKeys = new Set((existing.locations || []).map(l => `${l.line}:${l.endLine || l.line}`));
      for (const loc of f.locations || []) {
        const lk = `${loc.line}:${loc.endLine || loc.line}`;
        if (locKeys.has(lk)) continue;
        locKeys.add(lk);
        existing.locations.push(loc);
      }
      existing.locations.sort((a, b) => a.line - b.line);

      if (rank(f.severity) > rank(existing.severity)) existing.severity = f.severity;
      existing.issue = pickLongest(existing.issue, f.issue) || existing.issue;
      existing.remediation = pickLongest(existing.remediation, f.remediation) || existing.remediation;
      existing.whyItMatters = pickLongest(existing.whyItMatters, f.whyItMatters);
      existing.howItHappens = pickLongest(existing.howItHappens, f.howItHappens);
      existing.properFix = pickLongest(existing.properFix, f.properFix);
      existing.hipaaReference = pickLongest(existing.hipaaReference, f.hipaaReference);
      existing.confidence = existing.confidence || f.confidence;
    }

    const dedupedAllFindings = Array.from(byId.values());
    const findingsBySeverity = {
      critical: dedupedAllFindings.filter(f => f.severity === 'critical'),
      high: dedupedAllFindings.filter(f => f.severity === 'high'),
      medium: dedupedAllFindings.filter(f => f.severity === 'medium'),
      low: dedupedAllFindings.filter(f => f.severity === 'low'),
    };

    return {
      totalFiles,
      analyzedFiles,
      totalFindings: dedupedAllFindings.length,
      findingsBySeverity,
      allFindings: dedupedAllFindings,
    };
  }
}

export const analyzerAgent = new AnalyzerAgent();
