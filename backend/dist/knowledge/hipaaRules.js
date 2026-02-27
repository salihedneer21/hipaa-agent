/**
 * HIPAA Compliance Rules Knowledge Base
 * Based on HIPAA Security Rule (45 CFR Part 160 and Part 164)
 */
export const HIPAA_RULES = {
    phi_exposure: {
        name: 'PHI Exposure Detection',
        description: 'Detect potential exposure of Protected Health Information',
        severity: 'critical',
        patterns: [
            'patient_name', 'patient_id', 'ssn', 'social_security',
            'date_of_birth', 'dob', 'medical_record', 'diagnosis',
            'treatment', 'prescription', 'health_plan', 'insurance_id',
            'beneficiary', 'medical_history', 'lab_result', 'health_condition',
            '(console\\.log|print|logger).*?(patient|ssn|diagnosis|medical)',
        ],
        remediation: 'Never log or expose PHI. Use pseudonymization or tokenization.',
    },
    encryption_at_rest: {
        name: 'Encryption at Rest',
        description: 'Data containing PHI must be encrypted when stored',
        severity: 'critical',
        patterns: [
            'writeFile.*?(patient|medical|health|ssn)',
            'localStorage\\.setItem.*?(patient|medical|health)',
            'sessionStorage\\.setItem.*?(patient|medical)',
            'INSERT INTO.*?(patient|medical|health)',
        ],
        remediation: 'Use AES-256 encryption for all PHI at rest. Use encrypted databases.',
    },
    encryption_in_transit: {
        name: 'Encryption in Transit',
        description: 'PHI must be encrypted during transmission',
        severity: 'critical',
        patterns: [
            'http:\\/\\/(?!localhost|127\\.0\\.0\\.1)',
            'fetch\\([\'"]http:',
            'axios\\.(get|post).*?http:',
            'ftp:\\/\\/',
        ],
        remediation: 'Use HTTPS/TLS for all data transmission. Minimum TLS 1.2.',
    },
    access_control: {
        name: 'Access Control Violations',
        description: 'PHI access must be restricted and authenticated',
        severity: 'high',
        patterns: [
            'password\\s*[=:]\\s*[\'"][^\'"]+[\'"]',
            'api_key\\s*[=:]\\s*[\'"][^\'"]+[\'"]',
            'secret\\s*[=:]\\s*[\'"][^\'"]+[\'"]',
            'token\\s*[=:]\\s*[\'"][^\'"]+[\'"]',
            'PUBLIC.*?(patient|medical|health)',
        ],
        remediation: 'Implement role-based access control. Never hardcode credentials.',
    },
    audit_logging: {
        name: 'Audit Logging Requirements',
        description: 'All PHI access must be logged for audit trails',
        severity: 'high',
        patterns: [
            '(get|fetch|retrieve).*?(patient|medical)(?!.*audit)',
            '(update|delete).*?(patient|medical)(?!.*log)',
        ],
        remediation: 'Implement comprehensive audit logging for all PHI access.',
    },
    sql_injection: {
        name: 'SQL Injection Vulnerability',
        description: 'SQL injection can expose PHI',
        severity: 'critical',
        patterns: [
            'query\\s*\\(\\s*[`\'"].*?\\$\\{',
            'execute\\s*\\(.*?\\+',
            'raw\\s*\\(.*?\\$\\{',
            '\\.query\\(`[^`]*\\$\\{',
        ],
        remediation: 'Use parameterized queries. Never concatenate user input into SQL.',
    },
    xss_vulnerability: {
        name: 'XSS Vulnerability',
        description: 'XSS can expose PHI in browser',
        severity: 'high',
        patterns: [
            'dangerouslySetInnerHTML',
            'innerHTML\\s*=',
            'document\\.write',
            'eval\\s*\\(',
        ],
        remediation: 'Sanitize all user input. Use React/Vue built-in XSS protection.',
    },
    session_management: {
        name: 'Session Management',
        description: 'Sessions accessing PHI must be properly managed',
        severity: 'medium',
        patterns: [
            'session(?!.*expire|.*timeout|.*maxAge)',
            'cookie(?!.*secure|.*httpOnly)',
        ],
        remediation: 'Implement automatic session timeout. Use secure session storage.',
    },
    error_handling: {
        name: 'Error Handling & Information Disclosure',
        description: 'Errors must not expose PHI or system details',
        severity: 'medium',
        patterns: [
            'console\\.error.*?(patient|medical|ssn)',
            'res\\.send\\(.*?err',
            'stack.*?trace',
            'DEBUG\\s*[=:]\\s*true',
        ],
        remediation: 'Use generic error messages. Log details server-side only.',
    },
    third_party: {
        name: 'Third Party & BAA Requirements',
        description: 'Third-party services handling PHI need BAA',
        severity: 'high',
        patterns: [
            '(twilio|sendgrid|mailgun).*?(patient|medical)',
            '(stripe|paypal).*?(patient|medical)',
            '(s3|gcs|azure).*?upload.*?(patient|medical)',
            '(analytics|tracking).*?(patient|medical)',
        ],
        remediation: 'Ensure BAA agreements with all third-party services handling PHI.',
    },
};
export const ANALYZABLE_EXTENSIONS = [
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.java', '.go', '.rb', '.php',
    '.sql', '.yml', '.yaml', '.json',
    '.env', '.config', '.cfg',
];
export const SKIP_DIRECTORIES = [
    'node_modules', '__pycache__', 'venv', '.git',
    'dist', 'build', '.next', 'coverage', '.nyc_output',
];
