import OpenAI from 'openai';
import logger from '../utils/logger.js';

export type ThirdPartyDetectionSignals = {
  dependencyNames: string[];
  importSpecifiers: string[];
  envKeys: string[];
  domains: string[];
};

export type ThirdPartyDetectionEvidence = {
  kind: 'dependency' | 'import' | 'env' | 'domain';
  value: string;
};

export type ThirdPartyDetectionService = {
  name: string;
  domain?: string | null;
  category?: string | null;
  evidence: ThirdPartyDetectionEvidence[];
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function extractJson(text: string): string | null {
  const fence = text.match(/```json\\s*([\\s\\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return null;
}

export async function detectThirdPartyServicesWithLlm(signals: ThirdPartyDetectionSignals): Promise<ThirdPartyDetectionService[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for third-party service detection');
  }

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
                  kind: { type: 'string', enum: ['dependency', 'import', 'env', 'domain'] },
                  value: { type: 'string' },
                },
                required: ['kind', 'value'],
              },
            },
	          },
	          // OpenAI strict JSON schema requires required[] to include every property key.
	          required: ['name', 'domain', 'category', 'evidence'],
	        },
	      },
	    },
    required: ['services'],
  } as const;

  const instructions = `You are a security engineer helping with HIPAA compliance.

Goal: identify which *external third-party service providers* (SaaS / hosted APIs) this codebase integrates with.

Inputs:
- NPM dependency names
- Import specifiers
- Environment variable keys
- Outbound domains/hosts observed in source/config

Rules:
- Only include providers that are supported by at least one input signal. Do not invent vendors.
- Exclude open-source libraries/frameworks that run in-app (react, express, lodash, eslint, etc.). We only want external vendors.
- For each provider, include evidence items that match EXACTLY one of the provided signal values.
- Prefer an apex domain when possible (e.g. "twilio.com" instead of "api.twilio.com"). If unsure, domain=null.
- Keep the list focused and deduplicated (max 30 providers).`;

  const input = `Signals (choose evidence values from these lists only):

dependencyNames:
${JSON.stringify(signals.dependencyNames)}

importSpecifiers:
${JSON.stringify(signals.importSpecifiers)}

envKeys:
${JSON.stringify(signals.envKeys)}

domains:
${JSON.stringify(signals.domains)}

Return JSON only.`;

  try {
    const response = await client.responses.create({
      model: process.env.HIPAA_AGENT_THIRD_PARTY_MODEL || 'gpt-4o-mini',
      instructions,
      input,
      temperature: 0.2,
      text: {
        format: {
          type: 'json_schema',
          name: 'third_party_detection',
          strict: true,
          schema,
        },
        verbosity: 'medium',
      },
    });

    const rawText = response.output_text || '';
    const jsonText = extractJson(rawText) || rawText;
    const parsed = JSON.parse(jsonText) as { services: ThirdPartyDetectionService[] };
    return Array.isArray(parsed.services) ? parsed.services : [];
  } catch (e: any) {
    logger.warn({ err: e }, 'Third-party detection agent failed');
    throw e;
  }
}
