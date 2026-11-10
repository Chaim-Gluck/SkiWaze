import { useTranslation } from 'react-i18next';
import pinUrl from '../assets/logo-pin.png';

interface Props {
  className?: string;
}

/**
 * SkiWays header lockup: the teardrop-pin ski icon + the "SkiWays" wordmark
 * ("Ways" in the brand blue→green gradient) and the "NAVIGATE THE SLOPES" tagline.
 *
 * The user-facing name is deliberately NOT the repository/package name (`skiwaze`): the wordmark is
 * the one thing a visitor sees. Repository/package names and browser-storage identifiers stay
 * unchanged so a branding update cannot break links or returning users' saved settings.
 */
export function Logo({ className }: Props) {
  const { t } = useTranslation();
  return (
    <span className={className}>
      <img src={pinUrl} alt="" className="logo-pin" />
      <span className="logo-words">
        <span className="logo-name">
          Ski<span className="logo-accent">Ways</span>
        </span>
        {/* The wordmark is the brand and never translates; the tagline is a sentence, so it does. */}
        <span className="logo-tag">{t('app.tagline')}</span>
      </span>
    </span>
  );
}
