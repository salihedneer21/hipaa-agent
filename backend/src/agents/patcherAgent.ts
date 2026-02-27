/**
 * Security Patcher Agent
 * Generates patches for HIPAA compliance issues
 */

import Anthropic from '@anthropic-ai/sdk';
import { Finding, AnalysisResult } from './analyzerAgent.js';
import { RepoFile } from '../services/githubService.js';

export interface Patch {
  file: string;
  originalContent: string;
  patchedContent: string | null;
  changes: string[];
  explanation: string;
  error?: string;
}

export interface PatchResult {
  totalFiles: number;
  patchesGenerated: number;
  patches: Patch[];
}

const SYSTEM_PROMPT = `You are a security engineer specializing in HIPAA compliance remediation.

Your task is to generate secure code patches that fix HIPAA compliance violations.

Follow these principles:
1. **Minimal Changes**: Only modify what's necessary
2. **Backward Compatibility**: Preserve existing functionality
3. **Security Best Practices**: Follow OWASP and HIPAA guidelines

Common fixes:
- Replace HTTP with HTTPS
- Add encryption for PHI storage
- Remove PHI from logs
- Add authentication/authorization
- Implement audit logging
- Use parameterized queries
- Add input validation`;

export class PatcherAgent {
  private client: Anthropic;
  private model: string;

  constructor(model: string = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic();
    this.model = model;
  }

  async generatePatch(
    filePath: string,
    content: string,
    findings: Finding[]
  ): Promise<Patch> {
    if (findings.length === 0) {
      return {
        file: filePath,
        originalContent: content,
        patchedContent: null,
        changes: [],
        explanation: 'No issues to fix',
      };
    }

    const findingsText = findings
      .map(f => `- Line ${f.line}: ${f.issue} (${f.severity})`)
      .join('\n');

    const prompt = `Fix the HIPAA compliance issues in this file:

**File**: ${filePath}

**Issues to fix**:
${findingsText}

**Current Code**:
\`\`\`
${content}
\`\`\`

Provide the complete fixed file content.

Format your response as:
PATCHED_CODE:
\`\`\`
[complete fixed file content]
\`\`\`

CHANGES:
1. [description of change 1]
2. [description of change 2]

EXPLANATION:
[brief explanation of security improvements]`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      return this.parsePatchResponse(filePath, content, text);
    } catch (error) {
      return {
        file: filePath,
        originalContent: content,
        patchedContent: null,
        changes: [],
        explanation: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private parsePatchResponse(filePath: string, originalContent: string, response: string): Patch {
    const patch: Patch = {
      file: filePath,
      originalContent,
      patchedContent: null,
      changes: [],
      explanation: '',
    };

    // Extract patched code
    const codeMatch = response.match(/PATCHED_CODE:\s*```[\w]*\n([\s\S]*?)```/);
    if (codeMatch) {
      patch.patchedContent = codeMatch[1].trim();
    }

    // Extract changes
    const changesMatch = response.match(/CHANGES:\s*([\s\S]*?)(?=EXPLANATION:|$)/);
    if (changesMatch) {
      patch.changes = changesMatch[1]
        .split('\n')
        .filter(line => line.trim().match(/^\d+\./))
        .map(line => line.replace(/^\d+\.\s*/, '').trim());
    }

    // Extract explanation
    const explanationMatch = response.match(/EXPLANATION:\s*([\s\S]*?)$/);
    if (explanationMatch) {
      patch.explanation = explanationMatch[1].trim();
    }

    return patch;
  }

  async generatePatchesForRepo(
    files: RepoFile[],
    analysisResult: AnalysisResult
  ): Promise<PatchResult> {
    // Group findings by file
    const findingsByFile = new Map<string, Finding[]>();
    for (const finding of analysisResult.allFindings) {
      const existing = findingsByFile.get(finding.file) || [];
      existing.push(finding);
      findingsByFile.set(finding.file, existing);
    }

    const patches: Patch[] = [];

    for (const [filePath, findings] of findingsByFile) {
      const file = files.find(f => f.path === filePath);
      if (!file) continue;

      const patch = await this.generatePatch(filePath, file.content, findings);
      patches.push(patch);
    }

    return {
      totalFiles: findingsByFile.size,
      patchesGenerated: patches.filter(p => p.patchedContent !== null).length,
      patches,
    };
  }
}

export const patcherAgent = new PatcherAgent();
