import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { detectThirdPartyServicesWithLlm } from '../agents/thirdPartyDetectionAgent.js';

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
  const normalizedName = normalizeProviderNameKey(name) || (name || '').toLowerCase().trim();
  const normalizedDomain = normalizeDomain(domain) || '';
  const hash = crypto
    .createHash('sha256')
    .update(`${normalizedName}::${normalizedDomain}`)
    .digest('hex')
    .slice(0, 10);
  return `${base || 'provider'}_${hash}`;
}

function extractDomainsFromText(text: string, options?: { allowBare?: boolean }): string[] {
  const found = new Set<string>();
  const urlHostRegex = /\bhttps?:\/\/([a-zA-Z0-9.${}_-]+\.[a-zA-Z]{2,})(?::\d+)?\b/g;
  const bareDomainRegex = /\b([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)\b/g;

  const pushDomain = (rawHost: string) => {
    const cleaned = String(rawHost || '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/^\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/^\${[^}]+}\./g, '')
      .replace(/\${[^}]+}/g, '');

    if (!cleaned) return;
    if (cleaned === 'localhost' || cleaned === '127.0.0.1' || cleaned === '0.0.0.0' || cleaned === '[::1]') return;
    if (cleaned.endsWith('.local')) return;

    // If the host is templated, salvage the trailing domain (e.g. "${id}.api-us.example.com" -> "example.com").
    const m = cleaned.match(/([a-z0-9-]+\.[a-z]{2,6})$/i);
    const host = (m?.[1] || cleaned).toLowerCase();
    if (!host.includes('.')) return;

    const lastLabel = host.split('.').pop() || '';
    // Avoid common false-positives like "a.patientId" in code.
    if (lastLabel.length < 2 || lastLabel.length > 6) return;
    if (!/^[a-z]+$/.test(lastLabel)) return;
    // Avoid obvious file extensions.
    if (/\.(ts|tsx|js|jsx|json|yaml|yml|md|png|jpg|jpeg|svg|css|map)$/.test(host)) return;
    found.add(host);
  };

  let match: RegExpExecArray | null = null;
  while ((match = urlHostRegex.exec(text))) {
    pushDomain(match[1] || '');
  }

  if (options?.allowBare) {
    while ((match = bareDomainRegex.exec(text))) {
      const candidate = match[1] || '';
      // Heuristic: only treat as a domain if it looks like a host (has a TLD-ish tail).
      if (!/[a-z0-9-]+\.[a-z]{2,6}$/i.test(candidate)) continue;
      pushDomain(candidate);
    }
  }
  return Array.from(found);
}

function extractImportSpecifiersFromText(text: string): string[] {
  const out = new Set<string>();
  const importFrom = /\bimport\s+[^;]*?\s+from\s+['"]([^'"]+)['"]/g;
  const importBare = /\bimport\s+['"]([^'"]+)['"]/g;
  const requireCall = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicImport = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

  const push = (value: string) => {
    const spec = String(value || '').trim();
    if (!spec) return;
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return;
    out.add(spec);
  };

  let match: RegExpExecArray | null = null;
  while ((match = importFrom.exec(text))) push(match[1] || '');
  while ((match = importBare.exec(text))) push(match[1] || '');
  while ((match = requireCall.exec(text))) push(match[1] || '');
  while ((match = dynamicImport.exec(text))) push(match[1] || '');
  return Array.from(out);
}

function extractEnvKeysFromText(text: string): string[] {
  const out = new Set<string>();
  const importMeta = /\bimport\.meta\.env\.([A-Z0-9_]{3,})\b/g;
  const processEnv = /\bprocess\.env\.([A-Z0-9_]{3,})\b/g;

  const push = (value: string) => {
    const key = String(value || '').trim();
    if (!key) return;
    if (!/^[A-Z0-9_]{3,}$/.test(key)) return;
    out.add(key);
  };

  let match: RegExpExecArray | null = null;
  while ((match = importMeta.exec(text))) push(match[1] || '');
  while ((match = processEnv.exec(text))) push(match[1] || '');
  return Array.from(out);
}

function normalizeProviderNameKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim()
    .slice(0, 64);
}

export async function detectThirdPartyServices(
  repoPath: string,
  fileTree: string[],
  options?: { strict?: boolean }
): Promise<DetectedThirdPartyService[]> {
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

  const dependencyNames = Array.from(depToFiles.keys())
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 900);

  const domainToFiles = new Map<string, Set<string>>();
  const importToFiles = new Map<string, Set<string>>();
  const envToFiles = new Map<string, Set<string>>();

  const candidateFiles = fileTree
    .filter(p => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|php|yml|yaml|json)$/i.test(p))
    .filter(p => !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|composer\.lock|Gemfile\.lock)$/i.test(p))
    .slice(0, 160);

  for (const rel of candidateFiles) {
    const full = path.join(repoPath, rel);
    try {
      const stat = await fs.stat(full);
      if (stat.size > 120_000) continue;
      const raw = await fs.readFile(full, 'utf-8');
      const ext = path.extname(rel).toLowerCase();
      const allowBare = ext === '.json' || ext === '.yml' || ext === '.yaml' || ext === '.md' || ext === '.txt';
      for (const domain of extractDomainsFromText(raw, { allowBare })) {
        const set = domainToFiles.get(domain) || new Set<string>();
        set.add(rel);
        domainToFiles.set(domain, set);
      }

      for (const spec of extractImportSpecifiersFromText(raw)) {
        const set = importToFiles.get(spec) || new Set<string>();
        set.add(rel);
        importToFiles.set(spec, set);
      }

      for (const key of extractEnvKeysFromText(raw)) {
        const set = envToFiles.get(key) || new Set<string>();
        set.add(rel);
        envToFiles.set(key, set);
      }
    } catch {
      // ignore
    }
  }

  const importSignals = Array.from(importToFiles.entries())
    .map(([specifier, files]) => ({
      specifier,
      files: Array.from(files).slice(0, 3),
    }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier))
    .slice(0, 160);

  const envSignals = Array.from(envToFiles.entries())
    .map(([key, files]) => ({
      key,
      files: Array.from(files).slice(0, 3),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 220);

  const domainSignals = Array.from(domainToFiles.entries())
    .map(([domain, files]) => ({
      domain,
      files: Array.from(files).slice(0, 3),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .slice(0, 90);

  if (!process.env.OPENAI_API_KEY) {
    if (options?.strict) {
      throw new Error('OPENAI_API_KEY is required to detect third-party services');
    }
    logger.warn('Third-party detection skipped (missing OPENAI_API_KEY)');
    return [];
  }

  const importSpecifiers = importSignals.map(s => s.specifier).slice(0, 300);
  const envKeys = envSignals.map(s => s.key).slice(0, 500);
  const domains = domainSignals.map(s => s.domain).slice(0, 200);

  const allowedDeps = new Set(dependencyNames);
  const allowedImports = new Set(importSpecifiers);
  const allowedEnv = new Set(envKeys);
  const allowedDomains = new Set(domains.map(d => normalizeDomain(d) || d));

  const firstFileFor = (kind: 'dependency' | 'import' | 'env' | 'domain', value: string): string => {
    const v = String(value || '').trim();
    if (!v) return '';
    const pick = (set?: Set<string>): string => {
      if (!set || set.size === 0) return '';
      return Array.from(set)[0] || '';
    };
    if (kind === 'dependency') return pick(depToFiles.get(v));
    if (kind === 'import') return pick(importToFiles.get(v));
    if (kind === 'env') return pick(envToFiles.get(v));
    if (kind === 'domain') return pick(domainToFiles.get(normalizeDomain(v) || v));
    return '';
  };

  try {
    const llmServices = await detectThirdPartyServicesWithLlm({
      dependencyNames,
      importSpecifiers,
      envKeys,
      domains,
    });

    const detected: DetectedThirdPartyService[] = [];
    const seen = new Set<string>();

    const domainLooksGrounded = (candidate: string): boolean => {
      const normalized = normalizeDomain(candidate);
      if (!normalized) return false;
      if (allowedDomains.has(normalized)) return true;
      for (const d of allowedDomains) {
        if (!d) continue;
        if (d === normalized) return true;
        if (d.endsWith(`.${normalized}`)) return true;
      }
      return false;
    };

    for (const svc of llmServices || []) {
      const name = typeof (svc as any).name === 'string' ? String((svc as any).name).trim() : '';
      if (!name) continue;

      const rawEvidence = Array.isArray((svc as any).evidence) ? (svc as any).evidence : [];
      const evidence: ThirdPartyEvidence[] = [];
      for (const ev of rawEvidence) {
        const kind = String(ev?.kind || '').trim() as any;
        const value = String(ev?.value || '').trim();
        if (!value) continue;

        if (kind === 'dependency') {
          if (!allowedDeps.has(value)) continue;
          const file = firstFileFor('dependency', value);
          if (!file) continue;
          evidence.push({ kind: 'dependency', value, file });
          continue;
        }

        if (kind === 'import') {
          if (!allowedImports.has(value)) continue;
          const file = firstFileFor('import', value);
          if (!file) continue;
          evidence.push({ kind: 'import', value, file });
          continue;
        }

        if (kind === 'env') {
          if (!allowedEnv.has(value)) continue;
          const file = firstFileFor('env', value);
          if (!file) continue;
          evidence.push({ kind: 'env', value, file });
          continue;
        }

        if (kind === 'domain') {
          const normalized = normalizeDomain(value) || value;
          if (!domainLooksGrounded(normalized)) continue;
          const file = firstFileFor('domain', normalized);
          if (!file) continue;
          evidence.push({ kind: 'domain', value: normalized, file });
          continue;
        }
      }

      if (evidence.length === 0) continue;

      let domain = normalizeDomain((svc as any).domain);
      if (domain && !domainLooksGrounded(domain)) domain = undefined;
      if (!domain) {
        const evDomain = evidence.find(e => e.kind === 'domain')?.value;
        domain = normalizeDomain(evDomain) || undefined;
      }

      const id = stableProviderId(name, domain);
      if (seen.has(id)) continue;
      seen.add(id);

      detected.push({
        id,
        name,
        domain,
        category: typeof (svc as any).category === 'string' && String((svc as any).category).trim()
          ? String((svc as any).category).trim()
          : undefined,
        evidence: evidence.slice(0, 12),
      });
    }

    detected.sort((a, b) => `${a.category || 'other'}:${a.name}`.localeCompare(`${b.category || 'other'}:${b.name}`));
    const final = detected.slice(0, 30);
    if (final.length === 0 && options?.strict) {
      throw new Error('No third-party services were detected from repo signals');
    }
    return final;
  } catch (e: any) {
    logger.warn({ err: e }, 'Third-party detection failed; returning empty list');
    if (options?.strict) throw e;
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
