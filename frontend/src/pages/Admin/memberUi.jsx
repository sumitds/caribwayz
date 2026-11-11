import React from 'react';

// Small pieces shared by the member admin pages (businesses, tiers,
// applications, settings), in the style of the other admin pages.

export const STATUS_COLORS = {
  pending: '#F5A623',
  active: '#2D8C00',
  suspended: '#7B3FA0',
  expired: '#888888',
  cancelled: '#CC2229',
  new: '#0E7AC4',
  invoiced: '#F5A623',
  paid: '#2D8C00',
  rejected: '#CC2229',
};

export const StatusPill = ({ status }) => {
  const color = STATUS_COLORS[status] || '#888888';
  return (
    <span style={{
      fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
      color, background: `${color}18`, padding: '0.2rem 0.6rem',
      borderRadius: 20, border: `1px solid ${color}55`, whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  );
};

export const fieldLabelStyle = {
  fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem',
};

export const selectStyle = {
  background: 'var(--bg-input)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text)',
  padding: '0.6rem 0.9rem', fontSize: '0.95rem', width: '100%',
};

export const textareaStyle = { ...selectStyle, resize: 'vertical', fontFamily: 'inherit' };

export const FieldError = ({ message }) => (message
  ? <span role="alert" style={{ fontSize: '0.78rem', color: 'var(--danger)' }}>{message}</span>
  : null);

/** A labelled <select>, <textarea> or other control, with its error below. */
export const Field = ({ label, htmlFor, error, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
    <label htmlFor={htmlFor} style={fieldLabelStyle}>{label}</label>
    {children}
    <FieldError message={error} />
  </div>
);

export const FilterChips = ({ options, value, onChange, counts = {} }) => (
  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
    {options.map((s) => {
      const active = value === s;
      const color = STATUS_COLORS[s] || '#CC2229';
      return (
        <button key={s} type="button" onClick={() => onChange(s)} aria-pressed={active} style={{
          padding: '0.3rem 0.85rem', borderRadius: 20, cursor: 'pointer',
          border: `1px solid ${active ? color : 'var(--border)'}`,
          background: active ? `${color}18` : 'transparent',
          color: active ? color : 'var(--text-muted)',
          fontWeight: 700, fontSize: '0.78rem', textTransform: 'capitalize',
        }}>
          {s === 'all' ? 'All' : s}{counts[s] !== undefined ? ` (${counts[s]})` : ''}
        </button>
      );
    })}
  </div>
);

export const PageHeader = ({ icon: Icon, title, subtitle, action }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
    <div>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <Icon size={26} color="#F5A623" /> {title}
      </h2>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>{subtitle}</p>
    </div>
    {action}
  </div>
);

export const EmptyState = ({ icon: Icon, children }) => (
  <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
    <Icon size={44} style={{ marginBottom: '1rem', opacity: 0.3 }} />
    {children}
  </div>
);

export const ErrorState = ({ message, onRetry }) => (
  <div role="alert" style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text)', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--danger)' }}>
    <p style={{ marginBottom: '0.9rem' }}>{message}</p>
    <button type="button" onClick={onRetry} style={{ padding: '0.45rem 1.1rem', borderRadius: 8, border: '1px solid var(--primary)', background: 'none', color: 'var(--primary)', fontWeight: 700, cursor: 'pointer' }}>
      Try again
    </button>
  </div>
);

export const smallButton = (color) => ({
  display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.7rem', borderRadius: 6,
  border: 'none', background: `${color}18`, color, cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem',
});
