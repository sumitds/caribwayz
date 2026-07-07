import React from 'react';

const Input = ({ label, error, type = 'text', ...props }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
    {label && (
      <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>
        {label}
      </label>
    )}
    <input
      type={type}
      style={{
        background: 'var(--bg-input)',
        border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        color: 'var(--text)',
        padding: '0.6rem 0.9rem',
        fontSize: '0.95rem',
        outline: 'none',
        width: '100%',
        transition: 'border-color 0.2s',
      }}
      {...props}
    />
    {error && <span style={{ fontSize: '0.78rem', color: 'var(--danger)' }}>{error}</span>}
  </div>
);

export default Input;
