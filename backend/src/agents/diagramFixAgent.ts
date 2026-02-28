/**
 * Diagram Fix Agent
 * Repairs invalid Mermaid diagrams based on a render/parse error.
 */

import { Agent, run } from '@openai/agents';
import logger from '../utils/logger.js';

const SYSTEM_INSTRUCTIONS = `You are an expert Mermaid diagram author.

Your job is to fix Mermaid syntax and structure issues.

Rules:
- Output ONLY the corrected Mermaid code (no markdown fences, no JSON).
- Keep the diagram meaning the same; do not invent new system behavior.
- Prefer flowchart TD unless the existing diagram is another type.
- Avoid special characters in node IDs; keep IDs simple and use labels for text.`;

export class DiagramFixAgent {
  private agent: Agent;

  constructor(model: string = 'gpt-4o') {
    this.agent = new Agent({
      name: 'Mermaid Diagram Fixer',
      instructions: SYSTEM_INSTRUCTIONS,
      model,
    });
  }

  async fixMermaid(params: { mermaid: string; error: string; context?: string }): Promise<string | null> {
    const prompt = `Fix this Mermaid diagram so it renders correctly.

Error:
${params.error}

Context (optional):
${params.context || 'n/a'}

Current Mermaid:
${params.mermaid}

Return ONLY corrected Mermaid code.`;

    try {
      const result = await run(this.agent, prompt);
      const text = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '');
      const fixed = text.trim();
      if (!fixed) return null;
      return fixed;
    } catch (error: any) {
      logger.error({ err: error }, 'Diagram fix failed');
      return null;
    }
  }
}

export const diagramFixAgent = new DiagramFixAgent();

