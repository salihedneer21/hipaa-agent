/**
 * Diagram Agent
 * Generates Mermaid diagrams (architecture + data flow) for easier system understanding
 */
import { Agent, run } from '@openai/agents';
import logger from '../utils/logger.js';
const SYSTEM_INSTRUCTIONS = `You are a senior software architect and security engineer.

Generate Mermaid diagrams that help an administrator understand how a codebase works and where risks occur.

Rules:
- Output diagrams that are clear and maintainable (use subgraphs for modules/folders).
- Prefer flowchart TD or sequenceDiagram.
- Use short node labels but meaningful.
- Only describe flows you can infer from provided evidence; avoid guessing.`;
export class DiagramAgent {
    agent;
    constructor(model = 'gpt-4o') {
        this.agent = new Agent({
            name: 'Mermaid Diagram Generator',
            instructions: SYSTEM_INSTRUCTIONS,
            model,
        });
    }
    async generateDiagrams(params) {
        const directoryStructure = params.fileTree.slice(0, 80).join('\n');
        const keyFilesText = params.keyFiles
            .slice(0, 8)
            .map(f => `### ${f.path}\n\`\`\`\n${f.content.substring(0, 2000)}\n\`\`\``)
            .join('\n\n');
        const prompt = `Generate Mermaid diagrams for this repository.

Repo: ${params.repoUrl}

README (excerpt):
${params.readme ? params.readme.substring(0, 2000) : 'No README'}

Directory structure (partial):
${directoryStructure}

Key files (excerpts):
${keyFilesText || 'No key files provided'}

Findings summary (high level):
${params.findingsSummary || 'No findings'}

Return STRICT JSON only (no markdown, no code fences) in this format:
{
  "diagrams": [
    { "name": "architecture", "title": "Architecture Overview", "mermaid": "flowchart TD\\n..." },
    { "name": "phi-data-flow", "title": "PHI / Sensitive Data Flow", "mermaid": "flowchart TD\\n..." }
  ]
}

Diagram requirements:
- Include an "architecture" flowchart showing major entrypoints, services/modules, and external dependencies.
- Include a "phi-data-flow" flowchart showing where sensitive data may enter, be processed, stored, logged, or transmitted.
- If something is unclear, include an explicit node like "Unknown / Needs Review" rather than inventing details.`;
        try {
            logger.info('Generating Mermaid diagrams');
            const result = await run(this.agent, prompt);
            const text = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '');
            return this.parseDiagrams(text);
        }
        catch (error) {
            logger.error({ err: error }, 'Diagram generation failed');
            return [];
        }
    }
    async generateFindingDiagram(params) {
        const directoryStructure = params.fileTree.slice(0, 80).join('\n');
        const locs = params.finding.locations
            .slice(0, 12)
            .map(l => `- line ${l.line}${l.endLine ? `-${l.endLine}` : ''}: ${l.code || ''}`.trim())
            .join('\n');
        const prompt = `Create ONE detailed Mermaid diagram for this specific security finding.

Repo: ${params.repoUrl}

README (excerpt):
${params.readme ? params.readme.substring(0, 1500) : 'No README'}

Directory structure (partial):
${directoryStructure}

Finding:
- id: ${params.finding.id}
- file: ${params.finding.file}
- severity: ${params.finding.severity}
- title: ${params.finding.title}
- issue: ${params.finding.issue}
- remediation: ${params.finding.remediation}

Evidence (locations):
${locs || '(none)'}

Target file (excerpt, may be truncated):
\`\`\`
${params.fileContent.substring(0, 6000)}
\`\`\`

Return STRICT JSON only (no markdown, no code fences) in this exact format:
{
  "diagram": {
    "name": "finding_${params.finding.id}",
    "title": "Finding Flow: ${params.finding.title}",
    "mermaid": "flowchart TD\\n..."
  }
}

Diagram requirements:
- Use flowchart TD.
- Show the full data path: entrypoints/sources -> transformations -> sinks (logs/storage/network).
- Include security controls that SHOULD exist (e.g., auth, validation, encryption, audit logging) as separate nodes.
- Mark "problem points" and "fix points" explicitly with labels like "[PROBLEM]" and "[FIX]".
- If something is unclear, include an "Unknown / Needs Review" node rather than guessing.`;
        logger.info({ findingId: params.finding.id }, 'Generating finding diagram');
        try {
            const result = await run(this.agent, prompt);
            const text = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '');
            const diagram = this.parseSingleDiagram(text);
            if (!diagram)
                throw new Error('Diagram agent returned invalid JSON');
            return diagram;
        }
        catch (error) {
            logger.error({ err: error, findingId: params.finding.id }, 'Finding diagram generation failed');
            throw error;
        }
    }
    parseDiagrams(response) {
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
            return [];
        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        }
        catch {
            return [];
        }
        const diagrams = Array.isArray(parsed?.diagrams) ? parsed.diagrams : [];
        return diagrams
            .map((d) => {
            const name = typeof d?.name === 'string' ? d.name.trim() : '';
            const title = typeof d?.title === 'string' ? d.title.trim() : name;
            const mermaid = typeof d?.mermaid === 'string' ? d.mermaid.trim() : '';
            if (!name || !mermaid)
                return null;
            return { name, title, mermaid };
        })
            .filter((d) => !!d);
    }
    parseSingleDiagram(response) {
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
        const d = parsed?.diagram;
        const name = typeof d?.name === 'string' ? d.name.trim() : '';
        const title = typeof d?.title === 'string' ? d.title.trim() : name;
        const mermaid = typeof d?.mermaid === 'string' ? d.mermaid.trim() : '';
        if (!name || !mermaid)
            return null;
        return { name, title, mermaid };
    }
}
export const diagramAgent = new DiagramAgent();
