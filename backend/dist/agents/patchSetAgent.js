/**
 * Patch Set Agent
 * Generates a multi-file patch plan (including new files) to remediate findings.
 *
 * IMPORTANT: This is proposal-only. Nothing is written until the user explicitly applies it.
 */
import { Agent, run } from '@openai/agents';
import logger from '../utils/logger.js';
const SYSTEM_INSTRUCTIONS = `You are a security engineer specializing in HIPAA compliance remediation.

You will generate a patch plan that fixes the provided findings with minimal, realistic code changes.

Hard rules:
- Output STRICT JSON only (no markdown, no code fences).
- Do NOT write "hypothetical", "placeholder", or TODO-style code as a fix.
- You MAY edit multiple files and you MAY add new files when needed.
- If you add a local import, it must refer to an existing repo file OR a file you add in this patch plan.
- Use relative imports for newly created local files (match the repo's import style).
- Do NOT invent non-existent package subpaths; prefer imports already used in the repo.
- Do not touch files in node_modules, dist, build, .git, or hidden directories.
- Prefer using existing utilities/libraries already present in the repo; do not add new deps unless unavoidable.

Return format:
{
  "patchSet": {
    "operations": [
      { "action": "modify|add", "path": "relative/path.ts", "content": "complete file content" }
    ],
    "changes": ["short bullet change", "..."],
    "explanation": "short explanation"
  }
}`;
export class PatchSetAgent {
    agent;
    constructor(model = 'gpt-4o') {
        this.agent = new Agent({
            name: 'HIPAA Patch Set Planner',
            instructions: SYSTEM_INSTRUCTIONS,
            model,
        });
    }
    async generatePatchSet(params) {
        const findingsText = params.findings
            .map(f => {
            const locs = (f.locations || [])
                .slice(0, 10)
                .map(l => `line ${l.line}${l.endLine ? `-${l.endLine}` : ''}${l.code ? `: ${l.code}` : ''}`)
                .join('; ');
            return `- [${f.severity}] (${f.ruleId}) ${f.title}: ${f.issue}\n  Remediation: ${f.remediation}\n  Evidence: ${locs || 'n/a'}`;
        })
            .join('\n\n');
        const directoryStructure = params.fileTree.slice(0, 120).join('\n');
        const nearby = (params.nearbyFiles || [])
            .slice(0, 6)
            .map(f => `### ${f.path}\n\`\`\`\n${(f.content || '').slice(0, 2500)}\n\`\`\``)
            .join('\n\n');
        const validation = (params.validationErrors && params.validationErrors.length > 0)
            ? `\n\nPrevious plan validation errors (fix these):\n- ${params.validationErrors.join('\n- ')}`
            : '';
        const prompt = `Create a patch plan for this repository.

Repo: ${params.repoUrl}

Directory structure (partial):
${directoryStructure}

package.json (excerpt, if present):
${params.packageJson ? params.packageJson.slice(0, 2500) : '(none provided)'}

Target file: ${params.targetFile.path}
Target file content:
\`\`\`
${params.targetFile.content}
\`\`\`

Nearby files (excerpts, may be empty):
${nearby || '(none)'}

Findings to fix (group related findings; avoid duplicate operations):
${findingsText || '(none)'}
${validation}

Output STRICT JSON only, matching the required schema in system instructions.`;
        try {
            logger.debug({ file: params.targetFile.path }, 'Generating patch set with OpenAI');
            const result = await run(this.agent, prompt);
            const text = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '');
            return this.parsePatchSet(text);
        }
        catch (error) {
            logger.error({ err: error, file: params.targetFile.path }, 'Patch set generation failed');
            return null;
        }
    }
    parsePatchSet(response) {
        const extractJson = (text) => {
            const fence = text.match(/```json\s*([\s\S]*?)```/i);
            const candidate = fence ? fence[1] : text;
            const start = candidate.indexOf('{');
            const end = candidate.lastIndexOf('}');
            if (start >= 0 && end > start)
                return candidate.slice(start, end + 1);
            return null;
        };
        const jsonText = extractJson(response);
        if (!jsonText)
            return null;
        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        }
        catch {
            return null;
        }
        const patchSet = parsed?.patchSet;
        const operationsRaw = Array.isArray(patchSet?.operations) ? patchSet.operations : [];
        const operations = operationsRaw
            .map((op) => {
            const action = typeof op?.action === 'string' ? op.action.trim().toLowerCase() : '';
            const filePath = typeof op?.path === 'string' ? op.path.trim() : '';
            const content = typeof op?.content === 'string' ? op.content : '';
            if ((action !== 'modify' && action !== 'add') || !filePath || !content)
                return null;
            return { action: action, path: filePath, content };
        })
            .filter((x) => x !== null);
        const changes = Array.isArray(patchSet?.changes)
            ? patchSet.changes.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()).slice(0, 20)
            : [];
        const explanation = typeof patchSet?.explanation === 'string' ? patchSet.explanation.trim() : '';
        if (operations.length === 0)
            return null;
        return { operations, changes, explanation };
    }
}
export const patchSetAgent = new PatchSetAgent();
