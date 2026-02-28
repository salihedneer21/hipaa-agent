import type { ThirdPartyBaaResearch } from '../services/thirdPartyService.js';
type ResearchInput = {
    name: string;
    domain?: string;
};
export declare function researchBaaForProvider(input: ResearchInput): Promise<ThirdPartyBaaResearch>;
export {};
