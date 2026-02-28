import { useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, HelpCircle, XCircle } from 'lucide-react';
import type { ThirdPartyService, ThirdPartyBaaConfirmationStatus } from '../types';

function statusLabel(status: ThirdPartyBaaConfirmationStatus): string {
  if (status === 'confirmed') return 'BAA confirmed';
  if (status === 'not_confirmed') return 'BAA not confirmed';
  return 'Needs review';
}

function availabilityBadge(availability?: string) {
  const v = availability || 'unknown';
  const label = v === 'yes' ? 'BAA available' : v === 'no' ? 'No BAA' : v === 'partial' ? 'Partial' : 'Unknown';
  const cls = v === 'yes' ? 'yes' : v === 'no' ? 'no' : v === 'partial' ? 'partial' : 'unknown';
  return <span className={`baa-badge ${cls}`}>{label}</span>;
}

export function ThirdPartyBAADeck({
  services,
  onConfirm,
}: {
  services: ThirdPartyService[];
  onConfirm: (providerId: string, status: ThirdPartyBaaConfirmationStatus) => Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cardMotion, setCardMotion] = useState<'left' | 'right' | null>(null);

  const { queue, reviewed } = useMemo(() => {
    const q: ThirdPartyService[] = [];
    const r: ThirdPartyService[] = [];
    for (const s of services || []) {
      const status = s.confirmation?.status || 'unknown';
      if (status === 'unknown') q.push(s);
      else r.push(s);
    }
    return { queue: q, reviewed: r };
  }, [services]);

  const current = queue[0] || null;
  const total = queue.length + reviewed.length;
  const reviewedCount = reviewed.length;

  const submit = async (status: ThirdPartyBaaConfirmationStatus) => {
    if (!current) return;
    setIsSubmitting(true);
    setCardMotion(status === 'confirmed' ? 'right' : 'left');
    try {
      await onConfirm(current.id, status);
    } finally {
      // allow the parent to update services; reset animation state
      setTimeout(() => setCardMotion(null), 220);
      setIsSubmitting(false);
    }
  };

  if (!current && reviewedCount === 0) {
    return (
      <div className="baa-empty">
        <HelpCircle size={28} />
        <div>
          <h3>No third-party services detected</h3>
          <p>We didn’t detect any external vendors from repo signals (dependencies/domains).</p>
        </div>
      </div>
    );
  }

  return (
    <div className="baa-deck">
      <div className="baa-deck-header">
        <div>
          <h2>Third-Party Services & BAAs</h2>
          <p className="baa-deck-subtitle">
            Confirm whether you have a signed BAA with each detected provider.
          </p>
        </div>
        <div className="baa-deck-progress">
          <span className="baa-deck-count">{reviewedCount}/{total} reviewed</span>
        </div>
      </div>

      {current ? (
        <div className={`baa-card ${cardMotion ? `motion-${cardMotion}` : ''}`}>
          <div className="baa-card-top">
            <div className="baa-provider">
              {current.logoUrl ? (
                <img
                  className="baa-logo"
                  src={current.logoUrl}
                  alt={`${current.name} logo`}
                  loading="lazy"
                  onError={(e) => {
                    const img = e.currentTarget;
                    const domain = current.domain || '';
                    if (!domain) return;
                    img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
                  }}
                />
              ) : (
                <div className="baa-logo-placeholder">{current.name.slice(0, 1).toUpperCase()}</div>
              )}
              <div className="baa-provider-meta">
                <div className="baa-provider-name">{current.name}</div>
                <div className="baa-provider-sub">
                  {current.category ? <span className="baa-category">{current.category}</span> : null}
                  {availabilityBadge(current.baa?.availability)}
                </div>
              </div>
            </div>
          </div>

          <div className="baa-card-body">
            <div className="baa-card-section">
              <div className="baa-card-label">What we found</div>
              <ul className="baa-evidence">
                {(current.evidence || []).slice(0, 4).map((ev, idx) => (
                  <li key={`${ev.file}:${ev.value}:${idx}`}>
                    <code>{ev.value}</code> in <code>{ev.file}</code>
                  </li>
                ))}
                {(current.evidence || []).length > 4 ? (
                  <li className="baa-evidence-more">+{(current.evidence || []).length - 4} more</li>
                ) : null}
              </ul>
            </div>

            <div className="baa-card-section">
              <div className="baa-card-label">BAA notes</div>
              <p className="baa-summary">
                {current.baa?.summary || 'No research summary available yet. Confirm BAA availability and requirements.'}
              </p>
              {current.baa?.pricing ? (
                <p className="baa-pricing">
                  <strong>Pricing:</strong> {current.baa.pricing}
                </p>
              ) : null}
              {current.baa?.howToGetBaa ? (
                <p className="baa-howto">
                  <strong>How to get a BAA:</strong> {current.baa.howToGetBaa}
                </p>
              ) : null}
              {current.baa?.docsUrl ? (
                <a className="baa-link" href={current.baa.docsUrl} target="_blank" rel="noreferrer">
                  View documentation <ExternalLink size={14} />
                </a>
              ) : null}
            </div>
          </div>

          <div className="baa-card-actions">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={isSubmitting}
              onClick={() => submit('not_confirmed')}
              title="Mark as not confirmed / needs review"
            >
              <XCircle size={16} />
              Not confirmed
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={isSubmitting}
              onClick={() => submit('confirmed')}
              title="Mark BAA as confirmed"
            >
              <CheckCircle2 size={16} />
              Confirm BAA
            </button>
          </div>
        </div>
      ) : (
        <div className="baa-all-done">
          <CheckCircle2 size={28} />
          <div>
            <h3>All providers reviewed</h3>
            <p>Nice — you’ve confirmed BAA status for all detected services in this session.</p>
          </div>
        </div>
      )}

      {reviewedCount > 0 ? (
        <div className="baa-reviewed">
          <div className="baa-reviewed-header">Reviewed</div>
          <div className="baa-reviewed-list">
            {reviewed.slice(0, 10).map((s) => (
              <div key={s.id} className={`baa-reviewed-item ${s.confirmation?.status || 'unknown'}`}>
                <div className="baa-reviewed-name">{s.name}</div>
                <div className="baa-reviewed-status">{statusLabel(s.confirmation?.status || 'unknown')}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
