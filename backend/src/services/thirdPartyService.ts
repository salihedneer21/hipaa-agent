import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import logger from '../utils/logger.js';

export type ThirdPartyEvidence = {
  kind: 'dependency' | 'domain' | 'url' | 'import' | 'env' | 'config' | 'other';
  value: string;
  file: string;
};

export interface DetectedThirdPartyService {
  id: string;
  name: string;
  domain?: string;
  category?: string;
  evidence: ThirdPartyEvidence[];
}

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readDeps(pkg: PackageJson): Set<string> {
  const out = new Set<string>();
  const add = (obj?: Record<string, string>) => {
    if (!obj) return;
    for (const k of Object.keys(obj)) out.add(k);
  };
  add(pkg.dependencies);
  add(pkg.devDependencies);
  add(pkg.peerDependencies);
  add(pkg.optionalDependencies);
  return out;
}

function computeLogoUrl(domain?: string): string | undefined {
  if (!domain) return undefined;
  // Clearbit is convenient for logos; fallback to Google favicon in the UI if blocked.
  return `https://logo.clearbit.com/${domain.replace(/^https?:\/\//, '')}`;
}

function normalizeDomain(raw: string | undefined | null): string | undefined {
  const value = String(raw || '').trim();
  if (!value) return undefined;
  try {
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return new URL(value).hostname;
    }
  } catch {
    // ignore
  }
  return value
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^\/\//, '')
    .replace(/[/?#].*$/, '')
    .trim();
}

function stableProviderId(name: string, domain?: string): string {
  const base = (domain || name || 'provider')
    .toLowerCase()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  const hash = crypto
    .createHash('sha256')
    .update(`${name}::${domain || ''}`)
    .digest('hex')
    .slice(0, 10);
  return `${base || 'provider'}_${hash}`;
}

function extractDomainsFromText(text: string): string[] {
  const found = new Set<string>();
  const regex = /\b(?:https?:)?\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?\b/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text))) {
    const host = (match[1] || '').toLowerCase();
    if (!host) continue;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') continue;
    if (host === '[::1]') continue;
    found.add(host);
  }
  return Array.from(found);
}

export async function detectThirdPartyServices(repoPath: string, fileTree: string[]): Promise<DetectedThirdPartyService[]> {
  const pkgFiles = fileTree
    .filter(p => p.endsWith('package.json'))
    // Avoid analyzing too many nested package.json files in very large monorepos (POC guardrail).
    .slice(0, 40);

  const depToFiles = new Map<string, Set<string>>();
  for (const rel of pkgFiles) {
    const full = path.join(repoPath, rel);
    try {
      const raw = await fs.readFile(full, 'utf-8');
      const parsed = JSON.parse(raw) as PackageJson;
      const deps = readDeps(parsed);
      for (const depName of deps) {
        if (!depName) continue;
        const set = depToFiles.get(depName) || new Set<string>();
        set.add(rel);
        depToFiles.set(depName, set);
      }
    } catch (e: any) {
      logger.debug({ err: e, file: rel }, 'Failed to parse package.json (ignored)');
    }
  }

  const dependencySignals = Array.from(depToFiles.entries())
    .map(([name, files]) => ({
      name,
      files: Array.from(files).slice(0, 3),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const domainToFiles = new Map<string, Set<string>>();
  const candidateFiles = fileTree
    .filter(p => /\.(ts|tsx|js|jsx|py|go|java|rb|php|yml|yaml|json)$/i.test(p))
    .filter(p => !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|composer\.lock|Gemfile\.lock)$/i.test(p))
    .slice(0, 160);

  for (const rel of candidateFiles) {
    const full = path.join(repoPath, rel);
    try {
      const stat = await fs.stat(full);
      if (stat.size > 120_000) continue;
      const raw = await fs.readFile(full, 'utf-8');
      for (const domain of extractDomainsFromText(raw)) {
        const set = domainToFiles.get(domain) || new Set<string>();
        set.add(rel);
        domainToFiles.set(domain, set);
      }
    } catch {
      // ignore
    }
  }

  const domainSignals = Array.from(domainToFiles.entries())
    .map(([domain, files]) => ({
      domain,
      files: Array.from(files).slice(0, 3),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .slice(0, 90);

  if (!process.env.OPENAI_API_KEY) {
    return [];
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      services: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            domain: { type: ['string', 'null'] },
            category: { type: ['string', 'null'] },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['dependency', 'domain', 'url', 'import', 'env', 'config', 'other'] },
                  value: { type: 'string' },
                  file: { type: 'string' },
                },
                required: ['kind', 'value', 'file'],
              },
            },
          },
          required: ['name', 'evidence'],
        },
      },
    },
    required: ['services'],
  } as const;

  const instructions = `You are a security engineer helping with HIPAA compliance.

Goal: Identify which *external third-party service providers* (SaaS / hosted APIs) this codebase integrates with.

Inputs you receive:
- NPM dependency signals (package names + which package.json files reference them)
- Observed outbound domains/hosts in source/config files

Rules:
- Only include providers that are supported by at least one input signal (dependency or domain). Do not invent vendors.
- Exclude open-source libraries/frameworks that run in-app (e.g. react, express, lodash). We only want *external vendors*.
- A provider should be a company/platform someone might need a contract/BAA with (communications, auth/identity, analytics, monitoring, storage/hosting, payments, etc).
- For each provider, include a short evidence list that cites the exact dependency/domain and the file where it was found.
- Prefer an apex domain when possible (e.g. "twilio.com" instead of "api.twilio.com"). If unknown, set domain=null.
- Keep the list focused and deduplicated (max 30 providers).`;

  const input = {
    dependencySignals: dependencySignals.slice(0, 700),
    domainSignals,
  };

  try {
    const response = await openai.responses.create({
      model: process.env.HIPAA_AGENT_THIRD_PARTY_MODEL || 'gpt-4o-mini',
      instructions,
      input: `Identify third-party providers used by this repo.\n\nSignals:\n${JSON.stringify(input, null, 2)}`,
      temperature: 0.2,
      text: {
        format: {
          type: 'json_schema',
          name: 'third_party_detection',
          strict: true,
          schema,
        },
        verbosity: 'low',
      },
    });

    const raw = response.output_text || '';
    const parsed = JSON.parse(raw) as {
      services: Array<{
        name: string;
        domain?: string | null;
        category?: string | null;
        evidence: ThirdPartyEvidence[];
      }>;
    };

    const seen = new Set<string>();
    const detected: DetectedThirdPartyService[] = [];

    for (const svc of Array.isArray(parsed.services) ? parsed.services : []) {
      const name = typeof svc.name === 'string' ? svc.name.trim() : '';
      if (!name) continue;
      const domain = normalizeDomain((svc as any).domain);
      const id = stableProviderId(name, domain);
      if (seen.has(id)) continue;
      seen.add(id);

      const evidence = Array.isArray((svc as any).evidence)
        ? (svc as any).evidence
          .map((ev: any) => ({
            kind: (ev?.kind || 'other') as ThirdPartyEvidence['kind'],
            value: String(ev?.value || '').trim(),
            file: String(ev?.file || '').trim(),
          }))
          .filter((ev: ThirdPartyEvidence) => Boolean(ev.value && ev.file))
          .slice(0, 12)
        : [];

      detected.push({
        id,
        name,
        domain,
        category: typeof (svc as any).category === 'string' && (svc as any).category.trim() ? (svc as any).category.trim() : undefined,
        evidence,
      });
    }

    detected.sort((a, b) => `${a.category || 'other'}:${a.name}`.localeCompare(`${b.category || 'other'}:${b.name}`));
    return detected.slice(0, 30);
  } catch (e: any) {
    logger.warn({ err: e }, 'Third-party detection failed; returning empty list');
    return [];
  }
}

export type ThirdPartyBaaAvailability = 'yes' | 'no' | 'partial' | 'unknown';
export type ThirdPartyBaaConfirmationStatus = 'unknown' | 'confirmed' | 'not_confirmed';

export interface ThirdPartyBaaResearch {
  availability: ThirdPartyBaaAvailability;
  summary: string;
  howToGetBaa?: string;
  pricing?: string;
  docsUrl?: string;
  sources?: string[];
  researchedAt: string;
}

export interface ThirdPartyServiceCard extends DetectedThirdPartyService {
  logoUrl?: string;
  baa?: ThirdPartyBaaResearch;
  confirmation?: { status: ThirdPartyBaaConfirmationStatus; updatedAt?: string };
}

export function enrichWithLogo(service: DetectedThirdPartyService): ThirdPartyServiceCard {
  return {
    ...service,
    logoUrl: computeLogoUrl(service.domain),
    confirmation: { status: 'unknown' },
  };
}
