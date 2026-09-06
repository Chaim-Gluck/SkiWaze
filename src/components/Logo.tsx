import { useTranslation } from 'react-i18next';
import pinUrl from '../assets/logo-pin.png';

interface Props {
  className?: string;
}

/**
 * SkiNav header lockup: the teardrop-pin ski icon + the "SKINAV" wordmark
 * ("NAV" in the brand blue→green gradient) and the "NAVIGATE THE SLOPES" tagline.
 *
 * The user-facing name is deliberately NOT the repository/package name (`skiwaze`): the wordmark is
 * the one thing a visitor sees, and "Waze" is someone else's trademark. Renaming the repo, the
 * package or the code identifiers would churn every path and import for no benefit here.
 */
export function Logo({ className }: Props) {
  const { t } = useTranslation();
  return (
    <span className={className}>
      <img src={pinUrl} alt="" className="logo-pin" />
      <span className="logo-words">
        <span className="logo-name">
          SKI<span className="logo-accent">NAV</span>
        </span>
        {/* The wordmark is the brand and never translates; the tagline is a sentence, so it does. */}
        <span className="logo-tag">{t('app.tagline')}</span>
      </span>
    </span>
  );
}
