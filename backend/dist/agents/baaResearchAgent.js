import OpenAI from 'openai';
import logger from '../utils/logger.js';
const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
const cache = new Map();
function cacheKey(input) {
    const name = (input.name || '').trim().toLowerCase();
    const domain = (input.domain || '').trim().toLowerCase();
    return `${name}::${domain}`;
}
function asAvailability(value) {
    if (value === 'yes' || value === 'no' || value === 'partial' || value === 'unknown')
        return value;
    return 'unknown';
}
export async function researchBaaForProvider(input) {
    const key = cacheKey(input);
    const cached = cache.get(key);
    if (cached)
        return cached;
    const researchedAt = new Date().toISOString();
    const providerLabel = input.domain ? `${input.name} (${input.domain})` : input.name;
    if (!process.env.OPENAI_API_KEY) {
        const fallback = {
            availability: 'unknown',
            summary: `Web research unavailable (missing OPENAI_API_KEY). Confirm whether ${providerLabel} offers a HIPAA BAA and what products are covered.`,
            researchedAt,
            sources: [],
        };
        cache.set(key, fallback);
        return fallback;
    }
    const schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
            availability: { type: 'string', enum: ['yes', 'no', 'partial', 'unknown'] },
            summary: { type: 'string' },
            howToGetBaa: { type: ['string', 'null'] },
            docsUrl: { type: ['string', 'null'] },
            pricing: { type: ['string', 'null'] },
        },
        required: ['availability', 'summary'],
    };
    const instructions = `You are a compliance researcher. Use web search to determine whether a vendor offers a HIPAA Business Associate Agreement (BAA).

Rules:
- Prefer official vendor documentation and reputable sources.
- If details are unclear, set availability="unknown" and explain what to confirm.
- Do not guess pricing. If not clearly published, say it is not publicly listed.
- Keep the summary short and actionable (2-4 sentences).`;
    const query = `Research HIPAA BAA availability for ${providerLabel}.

Return:
- availability: yes/no/partial/unknown
- summary: what is true and what is required (e.g., enterprise plan, specific products only)
- howToGetBaa: short steps
- docsUrl: best official link if found
- pricing: only if clearly published; otherwise null`;
    try {
        const response = await client.responses.create({
            model: process.env.HIPAA_AGENT_BAA_RESEARCH_MODEL || 'gpt-4o-mini',
            instructions,
            input: query,
            tool_choice: { type: 'web_search_preview' },
            tools: [
                {
                    type: 'web_search_preview',
                    search_context_size: 'low',
                    user_location: { type: 'approximate', country: 'US' },
                },
            ],
            include: ['web_search_call.action.sources'],
            temperature: 0.2,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'baa_research',
                    description: 'BAA availability research result for a third-party vendor',
                    strict: true,
                    schema,
                },
                verbosity: 'low',
            },
        });
        const raw = response.output_text || '';
        const parsed = JSON.parse(raw);
        const sources = [];
        for (const item of response.output || []) {
            if (item && item.type === 'web_search_call') {
                const src = item.action?.sources;
                if (Array.isArray(src)) {
                    for (const s of src) {
                        if (s && typeof s.url === 'string' && s.url.trim())
                            sources.push(s.url.trim());
                    }
                }
            }
        }
        const result = {
            availability: asAvailability(parsed.availability),
            summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : `Confirm whether ${providerLabel} offers a HIPAA BAA.`,
            howToGetBaa: typeof parsed.howToGetBaa === 'string' && parsed.howToGetBaa.trim() ? parsed.howToGetBaa.trim() : undefined,
            docsUrl: typeof parsed.docsUrl === 'string' && parsed.docsUrl.trim() ? parsed.docsUrl.trim() : undefined,
            pricing: typeof parsed.pricing === 'string' && parsed.pricing.trim() ? parsed.pricing.trim() : undefined,
            researchedAt,
            sources: Array.from(new Set(sources)).slice(0, 8),
        };
        cache.set(key, result);
        return result;
    }
    catch (e) {
        logger.warn({ err: e, provider: providerLabel }, 'BAA research failed; returning unknown');
        const fallback = {
            availability: 'unknown',
            summary: `Could not research ${providerLabel} BAA availability automatically. Confirm if they offer a HIPAA BAA and what products are covered.`,
            researchedAt,
            sources: [],
        };
        cache.set(key, fallback);
        return fallback;
    }
}
