/**
 * Documentation Agent
 * Generates project documentation using OpenAI Agents SDK
 */

import { Agent, run } from '@openai/agents';
import { RepoFile } from '../services/githubService.js';
import logger from '../utils/logger.js';

export interface ProjectDocumentation {
  overview: string;
  techStack: {
    languages: string[];
    frameworks: string[];
    dependencies: Array<{ name: string; version: string; purpose: string }>;
  };
  architecture: {
    structure: string;
    modules: Array<{ name: string; path: string; description: string; responsibilities: string[] }>;
  };
  businessContext: {
    purpose: string;
    targetUsers: string;
    keyFeatures: string[];
    dataHandled: string[];
  };
  securityNotes: string[];
  generatedAt: string;
}

const SYSTEM_INSTRUCTIONS = `You are a technical documentation expert analyzing software projects.

Your task is to analyze a codebase and generate comprehensive documentation that includes:

1. **Project Overview**: High-level summary of what the project does
2. **Tech Stack**: Languages, frameworks, and key dependencies with their purposes
3. **Architecture**: Project structure, modules, and their responsibilities
4. **Business Context**: Purpose, target users, key features, and data handled
5. **Security Notes**: Any security-relevant observations

Be concise but thorough. Focus on helping developers and stakeholders understand the codebase quickly.`;

export class DocumentationAgent {
  private agent: Agent;

  constructor(model: string = 'gpt-4o') {
    this.agent = new Agent({
      name: 'Documentation Generator',
      instructions: SYSTEM_INSTRUCTIONS,
      model,
    });
  }

  async generateDocumentation(
    files: RepoFile[],
    readme: string | null
  ): Promise<ProjectDocumentation> {
    // Extract key files for analysis
    const packageJsonFile = files.find(f => f.path.endsWith('package.json'));
    const requirementsFile = files.find(f => f.path.endsWith('requirements.txt'));
    const goModFile = files.find(f => f.path.endsWith('go.mod'));
    const pomFile = files.find(f => f.path.endsWith('pom.xml'));

    // Get directory structure
    const directories = new Set<string>();
    files.forEach(f => {
      const parts = f.path.split('/');
      if (parts.length > 1) {
        directories.add(parts.slice(0, -1).join('/'));
      }
    });

    // Sample key files for analysis (limit to avoid token limits)
    const keyFiles = files
      .filter(f =>
        f.path.includes('service') ||
        f.path.includes('controller') ||
        f.path.includes('model') ||
        f.path.includes('route') ||
        f.path.includes('api') ||
        f.path.endsWith('index.ts') ||
        f.path.endsWith('index.js') ||
        f.path.endsWith('main.py') ||
        f.path.endsWith('app.py')
      )
      .slice(0, 5);

    const filesSummary = keyFiles
      .map(f => `### ${f.path}\n\`\`\`\n${f.content.substring(0, 2000)}\n\`\`\``)
      .join('\n\n');

    const prompt = `Analyze this codebase and generate documentation:

**README** (if available):
${readme ? readme.substring(0, 3000) : 'No README found'}

**Directory Structure**:
${Array.from(directories).sort().slice(0, 30).join('\n')}

**File Count**: ${files.length} files

**Dependency Files**:
${packageJsonFile ? `package.json:\n${packageJsonFile.content.substring(0, 2000)}` : ''}
${requirementsFile ? `requirements.txt:\n${requirementsFile.content.substring(0, 1000)}` : ''}
${goModFile ? `go.mod:\n${goModFile.content.substring(0, 1000)}` : ''}
${pomFile ? `pom.xml (excerpt):\n${pomFile.content.substring(0, 1500)}` : ''}

**Key Source Files**:
${filesSummary}

Generate documentation in this exact JSON format:
\`\`\`json
{
  "overview": "High-level project description",
  "techStack": {
    "languages": ["language1", "language2"],
    "frameworks": ["framework1", "framework2"],
    "dependencies": [
      {"name": "pkg-name", "version": "1.0.0", "purpose": "what it does"}
    ]
  },
  "architecture": {
    "structure": "Description of project organization",
    "modules": [
      {"name": "Module Name", "path": "src/module", "description": "What it does", "responsibilities": ["resp1", "resp2"]}
    ]
  },
  "businessContext": {
    "purpose": "What problem does this solve",
    "targetUsers": "Who uses this",
    "keyFeatures": ["feature1", "feature2"],
    "dataHandled": ["data type 1", "data type 2"]
  },
  "securityNotes": ["security observation 1", "security observation 2"]
}
\`\`\``;

    try {
      logger.info('Generating project documentation');
      const result = await run(this.agent, prompt);
      const text = typeof result.finalOutput === 'string' ? result.finalOutput : String(result.finalOutput || '');
      return this.parseDocumentation(text);
    } catch (error: any) {
      logger.error({ err: error }, 'Documentation generation failed');
      return this.getDefaultDocumentation(files, readme);
    }
  }

  private parseDocumentation(response: string): ProjectDocumentation {
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          ...parsed,
          generatedAt: new Date().toISOString(),
        };
      }

      // Try parsing the whole response as JSON
      const parsed = JSON.parse(response);
      return {
        ...parsed,
        generatedAt: new Date().toISOString(),
      };
    } catch {
      // Return a basic documentation if parsing fails
      return {
        overview: 'Documentation generation encountered an issue. Please try again.',
        techStack: { languages: [], frameworks: [], dependencies: [] },
        architecture: { structure: 'Unable to analyze', modules: [] },
        businessContext: {
          purpose: 'Unable to determine',
          targetUsers: 'Unable to determine',
          keyFeatures: [],
          dataHandled: [],
        },
        securityNotes: [],
        generatedAt: new Date().toISOString(),
      };
    }
  }

  private getDefaultDocumentation(files: RepoFile[], readme: string | null): ProjectDocumentation {
    const languages = new Set<string>();
    files.forEach(f => {
      const ext = f.path.split('.').pop();
      if (ext === 'ts' || ext === 'tsx') languages.add('TypeScript');
      if (ext === 'js' || ext === 'jsx') languages.add('JavaScript');
      if (ext === 'py') languages.add('Python');
      if (ext === 'go') languages.add('Go');
      if (ext === 'java') languages.add('Java');
    });

    return {
      overview: readme ? readme.substring(0, 500) : 'No description available',
      techStack: {
        languages: Array.from(languages),
        frameworks: [],
        dependencies: [],
      },
      architecture: {
        structure: `Project contains ${files.length} files`,
        modules: [],
      },
      businessContext: {
        purpose: 'Unable to determine from code analysis',
        targetUsers: 'Unable to determine',
        keyFeatures: [],
        dataHandled: [],
      },
      securityNotes: [],
      generatedAt: new Date().toISOString(),
    };
  }
}

export const documentationAgent = new DocumentationAgent();
