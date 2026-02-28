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
export declare function detectThirdPartyServices(repoPath: string, fileTree: string[]): Promise<DetectedThirdPartyService[]>;
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
    confirmation?: {
        status: ThirdPartyBaaConfirmationStatus;
        updatedAt?: string;
    };
}
export declare function enrichWithLogo(service: DetectedThirdPartyService): ThirdPartyServiceCard;
