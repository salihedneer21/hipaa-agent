/**
 * Analysis Routes
 * API endpoints for HIPAA compliance analysis
 */
import { Router } from 'express';
import { GitHubService } from '../services/githubService.js';
import { AnalyzerAgent } from '../agents/analyzerAgent.js';
import { PatcherAgent } from '../agents/patcherAgent.js';
const router = Router();
// Store analysis sessions
const sessions = new Map();
/**
 * POST /api/analyze
 * Start analysis of a GitHub repository (public repos - no token needed)
 */
router.post('/analyze', async (req, res) => {
    const { repoUrl, generatePatches = true } = req.body;
    if (!repoUrl) {
        res.status(400).json({ error: 'repoUrl is required' });
        return;
    }
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    // Initialize session
    sessions.set(sessionId, {
        status: 'pending',
        progress: 0,
        message: 'Starting analysis...',
    });
    // Return session ID immediately
    res.json({ sessionId, message: 'Analysis started' });
    // Run analysis in background
    runAnalysis(sessionId, repoUrl, generatePatches);
});
async function runAnalysis(sessionId, repoUrl, generatePatches) {
    const session = sessions.get(sessionId);
    const service = new GitHubService(); // No token needed for public repos
    try {
        // Step 1: Clone repository
        session.status = 'analyzing';
        session.progress = 10;
        session.message = 'Cloning repository...';
        const repoData = await service.fetchRepoForAnalysis(repoUrl);
        session.progress = 30;
        session.message = `Found ${repoData.files.length} files to analyze...`;
        // Step 2: Analyze files
        const analyzer = new AnalyzerAgent();
        const analysisResult = await analyzer.analyzeRepository(repoData.files);
        session.progress = 70;
        session.message = `Found ${analysisResult.totalFindings} issues. ${generatePatches ? 'Generating patches...' : 'Complete.'}`;
        let patchResult = null;
        // Step 3: Generate patches (optional)
        if (generatePatches && analysisResult.totalFindings > 0) {
            session.status = 'patching';
            const patcher = new PatcherAgent();
            patchResult = await patcher.generatePatchesForRepo(repoData.files, analysisResult);
        }
        session.progress = 100;
        session.status = 'complete';
        session.message = 'Analysis complete';
        session.result = {
            repoUrl,
            readme: repoData.readme,
            filesAnalyzed: repoData.files.length,
            files: repoData.files, // Include file contents for code editor
            analysis: analysisResult,
            patches: patchResult,
        };
        // Cleanup
        await service.cleanup();
    }
    catch (error) {
        session.status = 'error';
        session.error = error instanceof Error ? error.message : 'Unknown error';
        session.message = 'Analysis failed';
        await service.cleanup();
    }
}
/**
 * GET /api/analyze/:sessionId
 * Get analysis status and results
 */
router.get('/analyze/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    res.json(session);
});
/**
 * POST /api/analyze-quick
 * Quick synchronous analysis (for smaller repos)
 */
router.post('/analyze-quick', async (req, res) => {
    const { repoUrl, generatePatches = false } = req.body;
    if (!repoUrl) {
        res.status(400).json({ error: 'repoUrl is required' });
        return;
    }
    const service = new GitHubService();
    try {
        // Clone and analyze
        const repoData = await service.fetchRepoForAnalysis(repoUrl);
        const analyzer = new AnalyzerAgent();
        const analysisResult = await analyzer.analyzeRepository(repoData.files);
        let patchResult = null;
        if (generatePatches && analysisResult.totalFindings > 0) {
            const patcher = new PatcherAgent();
            patchResult = await patcher.generatePatchesForRepo(repoData.files, analysisResult);
        }
        await service.cleanup();
        res.json({
            repoUrl,
            readme: repoData.readme,
            filesAnalyzed: repoData.files.length,
            files: repoData.files,
            analysis: analysisResult,
            patches: patchResult,
        });
    }
    catch (error) {
        await service.cleanup();
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Analysis failed',
        });
    }
});
export default router;
