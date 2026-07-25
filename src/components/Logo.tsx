import pinUrl from '../assets/logo-pin.png';

interface Props {
  className?: string;
}

/**
 * SkiWaze header lockup: the teardrop-pin ski icon + the "SKIWAZE" wordmark
 * ("WAZE" in the brand blue→green gradient) and the "NAVIGATE THE SLOPES" tagline.
 */
export function Logo({ className }: Props) {
  return (
    <span className={className}>
      <img src={pinUrl} alt="" className="logo-pin" />
      <span className="logo-words">
        <span className="logo-name">
          SKI<span className="logo-waze">WAZE</span>
        </span>
        <span className="logo-tag">NAVIGATE THE SLOPES</span>
      </span>
    </span>
  );
}
