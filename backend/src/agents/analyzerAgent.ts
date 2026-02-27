/**
 * HIPAA Analyzer Agent
 * Analyzes source code for HIPAA compliance violations using Claude
 */

import Anthropic from '@anthropic-ai/sdk';
import { HIPAA_RULES, HIPAARule } from '../knowledge/hipaaRules.js';
import { RepoFile } from '../services/githubService.js';
import logger from '../utils/logger.js';

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

const SYSTEM_PROMPT = `You are a HIPAA compliance security expert analyzing source code.

Your task is to identify potential HIPAA violations in the provided code. Focus on:

1. **PHI Exposure**: Any logging, printing, or exposure of Protected Health Information
2. **Encryption Issues**: Unencrypted storage or transmission of PHI
3. **Access Control**: Missing authentication, hardcoded credentials
4. **Audit Logging**: Missing audit trails for PHI access
5. **Data Integrity**: SQL injection, input validation issues
6. **Session Security**: Missing session timeouts, insecure sessions

For each issue, provide severity (critical/high/medium/low), line number, description, and fix.
Be thorough but avoid false positives.`;

export class AnalyzerAgent {
  private client: Anthropic;
  private model: string;

  constructor(model: string = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic();
    this.model = model;
  }

  private quickScan(filePath: string, content: string): Finding[] {
    const findings: Finding[] = [];
    const lines = content.split('\n');

    for (const [ruleId, rule] of Object.entries(HIPAA_RULES)) {
      for (const pattern of rule.patterns) {
        try {
          const regex = new RegExp(pattern, 'gi');

          lines.forEach((line, index) => {
            if (regex.test(line)) {
              findings.push({
                ruleId,
                ruleName: rule.name,
                severity: rule.severity,
                file: filePath,
                line: index + 1,
                code: line.trim().substring(0, 100),
                issue: `Pattern match: ${pattern}`,
                remediation: rule.remediation,
              });
            }
            regex.lastIndex = 0; // Reset regex state
          });
        } catch {
          // Skip invalid regex
        }
      }
    }

    return findings;
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

  async analyzeFile(filePath: string, content: string): Promise<Finding[]> {
    // Quick pattern scan
    const quickFindings = this.quickScan(filePath, content);

    // Deep analysis for critical files or files with findings
    if (quickFindings.length > 0 || this.isCriticalFile(filePath)) {
      return this.deepAnalyze(filePath, content, quickFindings);
    }

    return quickFindings;
  }

  private async deepAnalyze(
    filePath: string,
    content: string,
    quickFindings: Finding[]
  ): Promise<Finding[]> {
    // Truncate large files
    const truncatedContent = content.length > 30000
      ? content.substring(0, 30000) + '\n... [truncated]'
      : content;

    const quickSummary = quickFindings.length > 0
      ? `\nPreliminary findings:\n${quickFindings.slice(0, 5).map(f => `- Line ${f.line}: ${f.ruleName}`).join('\n')}`
      : '';

    const prompt = `Analyze this file for HIPAA compliance issues:

**File**: ${filePath}
${quickSummary}

**Code**:
\`\`\`
${truncatedContent}
\`\`\`

For each issue found, respond in this exact format:
FINDING:
- Severity: [critical/high/medium/low]
- Line: [number]
- Issue: [description]
- Fix: [recommendation]

If no issues found, respond with "NO_ISSUES_FOUND"`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      return this.parseFindings(filePath, text, quickFindings);
    } catch (error) {
      logger.error({ err: error, file: filePath }, 'Deep analysis failed');
      return quickFindings;
    }
  }

  private parseFindings(filePath: string, response: string, quickFindings: Finding[]): Finding[] {
    if (response.includes('NO_ISSUES_FOUND')) {
      return [];
    }

    const findings = [...quickFindings];
    const seenKeys = new Set(findings.map(f => `${f.file}:${f.line}:${f.issue}`));

    const blocks = response.split('FINDING:');
    for (const block of blocks.slice(1)) {
      const finding: Partial<Finding> = { file: filePath };

      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- Severity:')) {
          finding.severity = trimmed.split(':')[1].trim().toLowerCase() as Finding['severity'];
        } else if (trimmed.startsWith('- Line:')) {
          finding.line = parseInt(trimmed.split(':')[1].trim()) || 0;
        } else if (trimmed.startsWith('- Issue:')) {
          finding.issue = trimmed.split(':').slice(1).join(':').trim();
        } else if (trimmed.startsWith('- Fix:')) {
          finding.remediation = trimmed.split(':').slice(1).join(':').trim();
        }
      }

      const key = `${finding.file}:${finding.line}:${finding.issue}`;
      if (finding.issue && !seenKeys.has(key)) {
        seenKeys.add(key);
        findings.push({
          ruleId: 'deep_analysis',
          ruleName: 'Deep Analysis Finding',
          severity: finding.severity || 'medium',
          file: filePath,
          line: finding.line || 0,
          issue: finding.issue,
          remediation: finding.remediation || 'See HIPAA guidelines',
        });
      }
    }

    return findings;
  }

  async analyzeRepository(files: RepoFile[]): Promise<AnalysisResult> {
    const allFindings: Finding[] = [];
    let analyzedFiles = 0;

    for (const file of files) {
      try {
        const findings = await this.analyzeFile(file.path, file.content);
        allFindings.push(...findings);
        analyzedFiles++;
      } catch (error) {
        logger.error({ err: error, file: file.path }, 'File analysis failed');
      }
    }

    // Group by severity
    const findingsBySeverity = {
      critical: allFindings.filter(f => f.severity === 'critical'),
      high: allFindings.filter(f => f.severity === 'high'),
      medium: allFindings.filter(f => f.severity === 'medium'),
      low: allFindings.filter(f => f.severity === 'low'),
    };

    return {
      totalFiles: files.length,
      analyzedFiles,
      totalFindings: allFindings.length,
      findingsBySeverity,
      allFindings,
    };
  }
}

export const analyzerAgent = new AnalyzerAgent();
