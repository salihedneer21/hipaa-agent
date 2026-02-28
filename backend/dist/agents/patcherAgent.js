/**
 * Security Patcher Agent
 * Generates patches for HIPAA compliance issues using OpenAI Agents SDK
 */
import { Agent, run } from '@openai/agents';
import logger from '../utils/logger.js';
const SYSTEM_INSTRUCTIONS = `You are a security engineer specializing in HIPAA compliance remediation.

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
    agent;
    constructor(model = 'gpt-4o') {
        this.agent = new Agent({
            name: 'HIPAA Patcher',
            instructions: SYSTEM_INSTRUCTIONS,
            model,
        });
    }
    async generatePatch(filePath, content, findings) {
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
            .map(f => {
            const lines = (f.locations || [])
                .map(l => l.line)
                .filter(n => Number.isFinite(n) && n > 0)
                .slice(0, 8)
                .join(', ');
            const more = (f.locations?.length || 0) > 8 ? ` (+${(f.locations?.length || 0) - 8} more)` : '';
            return `- ${f.title} [${f.severity}] at lines ${lines}${more}: ${f.issue}`;
        })
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
            logger.debug({ file: filePath }, 'Generating patch with OpenAI');
            const result = await run(this.agent, prompt);
            logger.debug({ file: filePath, hasOutput: !!result.finalOutput }, 'Patch generated');
            const text = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '');
            return this.parsePatchResponse(filePath, content, text);
        }
        catch (error) {
            logger.error({
                err: error,
                file: filePath,
                message: error?.message,
                stack: error?.stack
            }, 'Patch generation failed');
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
    parsePatchResponse(filePath, originalContent, response) {
        const patch = {
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
    async generatePatchesForRepo(files, analysisResult) {
        // Group findings by file
        const findingsByFile = new Map();
        for (const finding of analysisResult.allFindings) {
            const existing = findingsByFile.get(finding.file) || [];
            existing.push(finding);
            findingsByFile.set(finding.file, existing);
        }
        const patches = [];
        const total = findingsByFile.size;
        let processed = 0;
        for (const [filePath, findings] of findingsByFile) {
            const file = files.find(f => f.path === filePath);
            if (!file)
                continue;
            processed++;
            logger.info({ file: filePath, progress: `${processed}/${total}` }, 'Generating patch');
            const patch = await this.generatePatch(filePath, file.content, findings);
            patches.push(patch);
            logger.info({ file: filePath, success: !!patch.patchedContent }, 'Patch complete');
        }
        return {
            totalFiles: findingsByFile.size,
            patchesGenerated: patches.filter(p => p.patchedContent !== null).length,
            patches,
        };
    }
}
export const patcherAgent = new PatcherAgent();
