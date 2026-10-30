import React, { useEffect, useMemo } from 'react';
import { MdEditNote } from 'react-icons/md';
import PublicLayout from './PublicLayout';
import { parseLegalDocument, parseInline, groupBullets, LEGAL_APPROVED, DRAFT_LABEL } from '../../legal/legalDocument';

const Inline = ({ text }) => parseInline(text).map((run, i) => (run.bold ? <strong key={i}>{run.text}</strong> : <React.Fragment key={i}>{run.text}</React.Fragment>));

/** Says the text is a draft, in words a reader cannot miss (as the app does). */
const DraftNote = () => (
  <div role="note" style={{
    display: 'flex', gap: '0.6rem', alignItems: 'flex-start', padding: '0.8rem 1rem', marginBottom: '1.5rem',
    background: 'rgba(178,106,0,0.1)', border: '1px solid rgba(178,106,0,0.5)', borderRadius: 12, color: '#111',
  }}>
    <MdEditNote size={22} color="#B26A00" style={{ flexShrink: 0 }} aria-hidden="true" />
    <p style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
      <strong>{DRAFT_LABEL}.</strong> This text has not yet been approved by a lawyer and may change.
    </p>
  </div>
);

/**
 * /privacy and /terms: the same text the app shows, from one source file per
 * document (src/legal/). [markdown] is that file's text.
 */
const LegalPage = ({ markdown }) => {
  const doc = useMemo(() => parseLegalDocument(markdown), [markdown]);

  useEffect(() => {
    document.title = `${doc.title}${LEGAL_APPROVED ? '' : ` (${DRAFT_LABEL})`}`;
  }, [doc.title]);

  return (
    <PublicLayout>
      <article style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 'clamp(1rem, 4vw, 2.25rem)', lineHeight: 1.65, color: '#1a1a1a' }}>
        <h1 style={{ fontSize: 'clamp(1.4rem, 4vw, 1.9rem)', fontWeight: 800, marginBottom: '0.4rem' }}>{doc.title}</h1>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          Version {doc.version} · Last updated {doc.lastUpdated}
        </p>
        {!LEGAL_APPROVED && <DraftNote />}
        {groupBullets(doc.blocks).map((block, i) => {
          if (block.type === 'heading') {
            return block.level === 2
              ? <h2 key={i} style={{ fontSize: '1.2rem', fontWeight: 800, margin: '1.75rem 0 0.6rem' }}><Inline text={block.text} /></h2>
              : <h3 key={i} style={{ fontSize: '1.02rem', fontWeight: 700, margin: '1.25rem 0 0.5rem' }}><Inline text={block.text} /></h3>;
          }
          if (block.type === 'list') {
            return (
              <ul key={i} style={{ paddingLeft: '1.4rem', margin: '0 0 0.9rem' }}>
                {block.items.map((item, j) => <li key={j} style={{ marginBottom: '0.35rem' }}><Inline text={item} /></li>)}
              </ul>
            );
          }
          return <p key={i} style={{ margin: '0 0 0.9rem' }}><Inline text={block.text} /></p>;
        })}
      </article>
    </PublicLayout>
  );
};

export default LegalPage;
