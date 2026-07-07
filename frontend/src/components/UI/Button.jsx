import React from 'react';

const variants = {
  primary: { background: 'var(--primary)', color: '#fff' },
  danger: { background: 'var(--danger)', color: '#fff' },
  secondary: { background: 'var(--bg-input)', color: 'var(--text)' },
  success: { background: 'var(--success)', color: '#fff' },
  ghost: { background: 'transparent', color: 'var(--primary)', border: '1px solid var(--primary)' },
};

const Button = ({
  children, onClick, type = 'button', variant = 'primary',
  loading = false, disabled = false, fullWidth = false, style = {}, size = 'md',
}) => {
  const sizes = { sm: '0.4rem 0.9rem', md: '0.6rem 1.4rem', lg: '0.8rem 2rem' };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        ...variants[variant],
        padding: sizes[size],
        border: variants[variant].border || 'none',
        borderRadius: 'var(--radius)',
        fontWeight: 600,
        fontSize: size === 'sm' ? '0.82rem' : '0.95rem',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.65 : 1,
        width: fullWidth ? '100%' : 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.4rem',
        transition: 'opacity 0.2s',
        ...style,
      }}
    >
      {loading && <span className="spinner" style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />}
      {children}
    </button>
  );
};

export default Button;
