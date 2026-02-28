import crypto from 'crypto';
import fs from 'fs/promises';
function base64UrlEncode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
    return buf.toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}
function base64UrlDecodeToBuffer(input) {
    const padded = input
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(input.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64');
}
function safeJsonParse(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function getGitHubApiBaseUrl() {
    return (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
}
function getAppSlug() {
    const slug = (process.env.GITHUB_APP_SLUG || '').trim();
    return slug ? slug : null;
}
function getAppId() {
    const raw = (process.env.GITHUB_APP_ID || '').trim();
    if (!raw)
        return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}
async function loadPrivateKey() {
    const fromEnv = process.env.GITHUB_APP_PRIVATE_KEY;
    if (fromEnv && fromEnv.trim()) {
        // Support single-line env var with \n escapes.
        return fromEnv.includes('\\n') ? fromEnv.replace(/\\n/g, '\n') : fromEnv;
    }
    const keyPath = (process.env.GITHUB_APP_PRIVATE_KEY_PATH || '').trim();
    if (!keyPath)
        return null;
    try {
        const raw = await fs.readFile(keyPath, 'utf-8');
        return raw;
    }
    catch {
        return null;
    }
}
function getStateSecret() {
    const secret = process.env.GITHUB_APP_STATE_SECRET;
    if (secret && secret.length >= 16)
        return secret;
    // Safe fallback for local/dev: in-memory secret invalidates states on restart.
    // (Better: set GITHUB_APP_STATE_SECRET in prod.)
    if (!globalThis.__hipaaAgentStateSecret) {
        globalThis.__hipaaAgentStateSecret = crypto.randomBytes(32).toString('hex');
    }
    return globalThis.__hipaaAgentStateSecret;
}
function signState(payload) {
    const encoded = base64UrlEncode(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', getStateSecret()).update(encoded).digest('base64');
    const sigUrl = sig.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${encoded}.${sigUrl}`;
}
function verifyState(token) {
    const [payloadPart, sigPart] = token.split('.');
    if (!payloadPart || !sigPart)
        return null;
    const expected = crypto.createHmac('sha256', getStateSecret()).update(payloadPart).digest('base64');
    const expectedUrl = expected.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    // Constant-time compare
    const a = Buffer.from(sigPart);
    const b = Buffer.from(expectedUrl);
    if (a.length !== b.length)
        return null;
    if (!crypto.timingSafeEqual(a, b))
        return null;
    const raw = base64UrlDecodeToBuffer(payloadPart).toString('utf-8');
    const payload = safeJsonParse(raw);
    if (!payload || payload.v !== 1)
        return null;
    // 30 minute expiry
    if (!Number.isFinite(payload.iat) || Date.now() - payload.iat > 30 * 60 * 1000)
        return null;
    if (!payload.clientId || !payload.redirectPath)
        return null;
    return payload;
}
function jwtSignRS256(payload, privateKeyPem) {
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
async function githubJson(url, options = {}) {
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
    const data = text ? safeJsonParse(text) : null;
    if (!res.ok) {
        const err = {
            status: res.status,
            message: (data && typeof data.message === 'string') ? data.message : `GitHub API request failed (${res.status})`,
            details: data,
        };
        throw Object.assign(new Error(err.message), { github: err });
    }
    return data;
}
export class GitHubAppService {
    isConfigured() {
        return Boolean(getAppSlug() && getAppId() && (process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH));
    }
    getAppSlugOrNull() {
        return getAppSlug();
    }
    createInstallUrl(clientId, redirectPath) {
        const slug = getAppSlug();
        if (!slug)
            throw new Error('GITHUB_APP_SLUG is not set');
        const payload = { v: 1, clientId, redirectPath, iat: Date.now() };
        const state = signState(payload);
        const url = new URL(`https://github.com/apps/${slug}/installations/new`);
        url.searchParams.set('state', state);
        return url.toString();
    }
    verifyInstallState(token) {
        return verifyState(token);
    }
    async createAppJwt() {
        const appId = getAppId();
        if (!appId)
            throw new Error('GITHUB_APP_ID is not set');
        const privateKey = await loadPrivateKey();
        if (!privateKey)
            throw new Error('GITHUB_APP_PRIVATE_KEY(_PATH) is not set');
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iat: now - 5,
            exp: now + 9 * 60,
            iss: appId,
        };
        return jwtSignRS256(payload, privateKey);
    }
    async getInstallation(installationId) {
        const apiBase = getGitHubApiBaseUrl();
        const jwt = await this.createAppJwt();
        return githubJson(`${apiBase}/app/installations/${installationId}`, {
            headers: { Authorization: `Bearer ${jwt}` },
        });
    }
    async createInstallationAccessToken(installationId) {
        const apiBase = getGitHubApiBaseUrl();
        const jwt = await this.createAppJwt();
        const data = await githubJson(`${apiBase}/app/installations/${installationId}/access_tokens`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${jwt}` },
            body: {},
        });
        return { token: data.token, expiresAt: data.expires_at };
    }
    async listInstallationRepositories(installationId) {
        const apiBase = getGitHubApiBaseUrl();
        const { token } = await this.createInstallationAccessToken(installationId);
        const repos = [];
        let page = 1;
        while (page <= 10) {
            const data = await githubJson(`${apiBase}/installation/repositories?per_page=100&page=${page}`, {
                headers: { Authorization: `token ${token}` },
            });
            repos.push(...(data.repositories || []));
            if (!data.repositories || data.repositories.length < 100)
                break;
            page++;
        }
        return repos;
    }
    async getRepo(owner, repo, installationId) {
        const apiBase = getGitHubApiBaseUrl();
        const { token } = await this.createInstallationAccessToken(installationId);
        return githubJson(`${apiBase}/repos/${owner}/${repo}`, {
            headers: { Authorization: `token ${token}` },
        });
    }
    async createPullRequest(params) {
        const apiBase = getGitHubApiBaseUrl();
        const { token } = await this.createInstallationAccessToken(params.installationId);
        return githubJson(`${apiBase}/repos/${params.owner}/${params.repo}/pulls`, {
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
