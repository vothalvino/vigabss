// Injected from frontend/package.json by Vite, which is kept aligned with the
// root release metadata by the backend release-identity test and tag workflow.
export const VIGABSS_RELEASE_VERSION = __VIGABSS_VERSION__;

interface BrandLockupProps {
  showVersion?: boolean;
  size?: 'compact' | 'default' | 'hero';
  inverse?: boolean;
  className?: string;
}

/**
 * One product lockup for the staff app and customer portal. The mark is a
 * repository-owned SVG rather than an emoji, so it renders consistently on
 * every platform and no longer carries the former FireISP flame cue.
 */
export function BrandLockup({
  showVersion = false,
  size = 'default',
  inverse = false,
  className = '',
}: BrandLockupProps) {
  const classes = [
    'vigabss-brand',
    `vigabss-brand--${size}`,
    inverse ? 'vigabss-brand--inverse' : '',
    className,
  ].filter(Boolean).join(' ');

  const accessibleName = showVersion
    ? `VigaBSS Alpha version ${VIGABSS_RELEASE_VERSION}`
    : 'VigaBSS Alpha';

  return (
    <span className={classes} aria-label={accessibleName}>
      <img className="vigabss-brand__mark" src="/icons/vigabss.svg" alt="" aria-hidden="true" />
      <span className="vigabss-brand__copy">
        <span className="vigabss-brand__line">
          <span className="vigabss-brand__name">VigaBSS</span>
          <span className="vigabss-brand__channel">Alpha</span>
        </span>
        {showVersion && (
          <span className="vigabss-brand__version">v{VIGABSS_RELEASE_VERSION}</span>
        )}
      </span>
    </span>
  );
}
