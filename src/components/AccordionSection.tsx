import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** Short one-line summary shown in the header while collapsed. */
  summary?: string | null;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * Collapsible sidebar section. The header (title + collapsed summary + chevron)
 * is always visible and clickable; the body renders only when open. The wrapped
 * child keeps its own markup — its internal heading/chrome is neutralized by CSS
 * (see `.acc-body .panel`), so no child component needs to change.
 */
export function AccordionSection({ title, summary, open, onToggle, children }: Props) {
  return (
    <section className={open ? 'acc open' : 'acc'}>
      <button type="button" className="acc-head" onClick={onToggle} aria-expanded={open}>
        <span className="acc-title">{title}</span>
        {!open && summary ? <span className="acc-summary">{summary}</span> : null}
        <span className="acc-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="acc-body">{children}</div>}
    </section>
  );
}
