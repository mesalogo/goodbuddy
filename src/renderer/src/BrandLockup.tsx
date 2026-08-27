type BrandLockupProps = {
  ariaLabel?: string
  className: string
  copyClassName: string
  logo?: string
  markClassName: string
  name: string
  role?: 'img'
  subtitle?: string
}

export function BrandLockup({
  ariaLabel,
  className,
  copyClassName,
  logo,
  markClassName,
  name,
  role,
  subtitle
}: BrandLockupProps): React.JSX.Element {
  return (
    <div aria-label={ariaLabel} className={className} role={role}>
      <div className={markClassName}>
        {logo && <img alt="" aria-hidden="true" src={logo} />}
      </div>
      <div className={copyClassName}>
        <strong>{name}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
    </div>
  )
}
