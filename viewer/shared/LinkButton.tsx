import type {ComponentPropsWithRef} from 'react';

type LinkButtonProps = ComponentPropsWithRef<'a'> & {
 href: string;
 variant?: 'primary' | 'secondary';
};

export function LinkButton({children, className = '', variant = 'primary', ...props}: LinkButtonProps) {
 return (
  <a {...props} className={`viewer-link-button gc-button gc-button-${variant} ${className}`.trimEnd()}>
   <span className="gc-button-content">{children}</span>
  </a>
 );
}
