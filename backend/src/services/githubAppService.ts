import crypto from 'crypto';
import fs from 'fs/promises';

export type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
  owner?: { login: string; type?: 'User' | 'Organization' };
};

export type GitHubInstallationInfo = {
  id: number;
  account?: { login: string; type?: 'User' | 'Organization' };
  repository_selection?: 'all' | 'selected';
  permissions?: Record<string, string>;
};

type GitHubApiError = {
  status: number;
  message: string;
  details?: any;
};

type StatePayload = {
  v: 1;
  clientId: string;
  redirectPath: string;
  iat: number;
};

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  const padded = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getGitHubApiBaseUrl(): string {
  return (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
}

function getAppSlug(): string | null {
  const slug = (process.env.GITHUB_APP_SLUG || '').trim();
  return slug ? slug : null;
}

function getAppId(): number | null {
  const raw = (process.env.GITHUB_APP_ID || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadPrivateKey(): Promise<string | null> {
  const fromEnv = process.env.GITHUB_APP_PRIVATE_KEY;
  if (fromEnv && fromEnv.trim()) {
    // Support single-line env var with \n escapes.
    return fromEnv.includes('\\n') ? fromEnv.replace(/\\n/g, '\n') : fromEnv;
  }

  const keyPath = (process.env.GITHUB_APP_PRIVATE_KEY_PATH || '').trim();
  if (!keyPath) return null;
  try {
    const raw = await fs.readFile(keyPath, 'utf-8');
    return raw;
  } catch {
    return null;
  }
}

function getStateSecret(): string {
  const secret = process.env.GITHUB_APP_STATE_SECRET;
  if (secret && secret.length >= 16) return secret;
  // Safe fallback for local/dev: in-memory secret invalidates states on restart.
  // (Better: set GITHUB_APP_STATE_SECRET in prod.)
  if (!(globalThis as any).__hipaaAgentStateSecret) {
    (globalThis as any).__hipaaAgentStateSecret = crypto.randomBytes(32).toString('hex');
  }
  return (globalThis as any).__hipaaAgentStateSecret as string;
}

function signState(payload: StatePayload): string {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getStateSecret()).update(encoded).digest('base64');
  const sigUrl = sig.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encoded}.${sigUrl}`;
}

function verifyState(token: string): StatePayload | null {
  const [payloadPart, sigPart] = token.split('.');
  if (!payloadPart || !sigPart) return null;
  const expected = crypto.createHmac('sha256', getStateSecret()).update(payloadPart).digest('base64');
  const expectedUrl = expected.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  // Constant-time compare
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expectedUrl);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  const raw = base64UrlDecodeToBuffer(payloadPart).toString('utf-8');
  const payload = safeJsonParse<StatePayload>(raw);
  if (!payload || payload.v !== 1) return null;
  // 30 minute expiry
  if (!Number.isFinite(payload.iat) || Date.now() - payload.iat > 30 * 60 * 1000) return null;
  if (!payload.clientId || !payload.redirectPath) return null;
  return payload;
}

function jwtSignRS256(payload: Record<string, unknown>, privateKeyPem: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${data}.${base64UrlEncode(signature)}`;
}

async function githubJson<T>(url: string, options: { method?: string; headers?: Record<string, string>; body?: any } = {}): Promise<T> {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'hipaa-agent',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  const data = text ? safeJsonParse<any>(text) : null;

  if (!res.ok) {
    const err: GitHubApiError = {
      status: res.status,
      message: (data && typeof data.message === 'string') ? data.message : `GitHub API request failed (${res.status})`,
      details: data,
    };
    throw Object.assign(new Error(err.message), { github: err });
  }

  return (data as T);
}

export class GitHubAppService {
  isConfigured(): boolean {
    return Boolean(getAppSlug() && getAppId() && (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH));
  }

  getAppSlugOrNull(): string | null {
    return getAppSlug();
  }

  createInstallUrl(clientId: string, redirectPath: string): string {
    const slug = getAppSlug();
    if (!slug) throw new Error('GITHUB_APP_SLUG is not set');
    const payload: StatePayload = { v: 1, clientId, redirectPath, iat: Date.now() };
    const state = signState(payload);
    const url = new URL(`https://github.com/apps/${slug}/installations/new`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  verifyInstallState(token: string): StatePayload | null {
    return verifyState(token);
  }

  async createAppJwt(): Promise<string> {
    const appId = getAppId();
    if (!appId) throw new Error('GITHUB_APP_ID is not set');
    const privateKey = await loadPrivateKey();
    if (!privateKey) throw new Error('GITHUB_APP_PRIVATE_KEY(_PATH) is not set');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 5,
      exp: now + 9 * 60,
      iss: appId,
    };
    return jwtSignRS256(payload, privateKey);
  }

  async getInstallation(installationId: number): Promise<GitHubInstallationInfo> {
    const apiBase = getGitHubApiBaseUrl();
    const jwt = await this.createAppJwt();
    return githubJson<GitHubInstallationInfo>(`${apiBase}/app/installations/${installationId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }

  async createInstallationAccessToken(installationId: number): Promise<{ token: string; expiresAt: string }> {
    const apiBase = getGitHubApiBaseUrl();
    const jwt = await this.createAppJwt();
    const data = await githubJson<{ token: string; expires_at: string }>(`${apiBase}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: {},
    });
    return { token: data.token, expiresAt: data.expires_at };
  }

  async listInstallationRepositories(installationId: number): Promise<GitHubRepo[]> {
    const apiBase = getGitHubApiBaseUrl();
    const { token } = await this.createInstallationAccessToken(installationId);

    const repos: GitHubRepo[] = [];
    let page = 1;
    while (page <= 10) {
      const data = await githubJson<{ repositories: GitHubRepo[] }>(`${apiBase}/installation/repositories?per_page=100&page=${page}`, {
        headers: { Authorization: `token ${token}` },
      });
      repos.push(...(data.repositories || []));
      if (!data.repositories || data.repositories.length < 100) break;
      page++;
    }

    return repos;
  }

  async getRepo(owner: string, repo: string, installationId: number): Promise<GitHubRepo> {
    const apiBase = getGitHubApiBaseUrl();
    const { token } = await this.createInstallationAccessToken(installationId);
    return githubJson<GitHubRepo>(`${apiBase}/repos/${owner}/${repo}`, {
      headers: { Authorization: `token ${token}` },
    });
  }

  async createPullRequest(params: {
    installationId: number;
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string; // "owner:branch"
    base: string;
  }): Promise<{ number: number; html_url: string }> {
    const apiBase = getGitHubApiBaseUrl();
    const { token } = await this.createInstallationAccessToken(params.installationId);
    return githubJson<{ number: number; html_url: string }>(`${apiBase}/repos/${params.owner}/${params.repo}/pulls`, {
      method: 'POST',
      headers: { Authorization: `token ${token}` },
      body: {
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      },
    });
  }
}

export const githubAppService = new GitHubAppService();

