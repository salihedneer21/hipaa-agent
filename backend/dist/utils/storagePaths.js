import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const BACKEND_DIR = path.resolve(__dirname, '..', '..');
export const REPO_ROOT_DIR = path.resolve(BACKEND_DIR, '..');
export const DATA_DIR = process.env.HIPAA_AGENT_DATA_DIR
    ? path.resolve(process.env.HIPAA_AGENT_DATA_DIR)
    : path.join(REPO_ROOT_DIR, '.hipaa-agent-data');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export function getSessionDir(sessionId) {
    return path.join(SESSIONS_DIR, sessionId);
}
export function getSessionRepoDir(sessionId) {
    return path.join(getSessionDir(sessionId), 'repo');
}
export function getSessionMetaPath(sessionId) {
    return path.join(getSessionDir(sessionId), 'meta.json');
}
export function getSessionResultPath(sessionId) {
    return path.join(getSessionDir(sessionId), 'result.json');
}
export function getSessionAnalysisPath(sessionId) {
    return path.join(getSessionDir(sessionId), 'analysis.json');
}
export function getSessionPatchesPath(sessionId) {
    return path.join(getSessionDir(sessionId), 'patches.json');
}
export function getSessionDiagramsDir(sessionId) {
    return path.join(getSessionDir(sessionId), 'diagrams');
}
export function getSessionSummaryPath(sessionId) {
    return path.join(getSessionDir(sessionId), 'summary.md');
}
