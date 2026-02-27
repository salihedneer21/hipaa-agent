/**
 * HIPAA Compliance Agent - Backend Server
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import analysisRoutes from './routes/analysis.js';
import logger from './utils/logger.js';
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;
// Middleware
app.use(cors());
app.use(express.json());
// Routes
app.use('/api', analysisRoutes);
// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Error handler
app.use((err, req, res, next) => {
    logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
});
app.listen(PORT, () => {
    logger.info({ port: PORT }, 'HIPAA Compliance Agent - Backend started');
    logger.info({ endpoints: [
            'POST /api/analyze - Start async analysis',
            'GET /api/analyze/:id - Get analysis status',
            'POST /api/analyze-quick - Quick sync analysis',
            'GET /health - Health check',
        ] }, 'Available endpoints');
});
export default app;
