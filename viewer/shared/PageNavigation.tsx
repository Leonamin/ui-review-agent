import type {MouseEventHandler} from 'react';
import {ArrowLeft} from 'lucide-react';
import './page-navigation.css';

interface BreadcrumbItem {
 href: string;
 label: string;
}

export function Breadcrumb({items}: {items: readonly BreadcrumbItem[]}) {
 return (
  <nav className="viewer-page-navigation" aria-label="상위 경로">
   <ol className="viewer-breadcrumb-list" role="list">
    {items.map(({href, label}, index) => (
     <li className="viewer-breadcrumb-item" key={href}>
      {index > 0 && <span className="viewer-breadcrumb-separator" aria-hidden="true">/</span>}
      <a href={href}>{label}</a>
     </li>
    ))}
   </ol>
  </nav>
 );
}

interface PageBackLinkProps {
 href: string;
 label: string;
 onClick?: MouseEventHandler<HTMLAnchorElement>;
}

export function PageBackLink({href, label, onClick}: PageBackLinkProps) {
 return (
  <a className="viewer-page-navigation viewer-page-back-link" href={href} onClick={onClick}>
   <ArrowLeft size={16} aria-hidden="true" focusable="false"/>
   <span>{label}</span>
  </a>
 );
}
