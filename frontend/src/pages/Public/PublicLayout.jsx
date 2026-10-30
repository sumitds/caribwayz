import React from 'react';
import { NavLink } from 'react-router-dom';

// The frame of the public pages (/membership, /privacy, /terms): no login,
// no sidebar, readable on a phone.

const links = [
  { to: '/membership', label: 'Membership' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/terms', label: 'Terms' },
];

const PublicLayout = ({ children }) => (
  <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
    <header style={{ background: '#fff', borderBottom: '1px solid var(--border)' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.9rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <img src="/logo.jpg" alt="" style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 8 }} />
          <span style={{ fontSize: '1.25rem', fontWeight: 900, letterSpacing: '-0.01em' }} aria-label="CaribWayz">
            <span style={{ color: '#D12229' }}>Ca</span><span style={{ color: '#F5A623' }}>rib</span><span style={{ color: '#3AAA3A' }}>Wa</span><span style={{ color: '#000000' }}>yz</span>
          </span>
        </div>
        <nav aria-label="CaribWayz pages" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {links.map(({ to, label }) => (
            <NavLink key={to} to={to} style={({ isActive }) => ({
              fontSize: '0.92rem', fontWeight: isActive ? 800 : 600,
              color: isActive ? '#D12229' : '#333', textDecoration: isActive ? 'underline' : 'none', textUnderlineOffset: 4,
            })}>
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
    <main style={{ flex: 1, width: '100%', maxWidth: 960, margin: '0 auto', padding: '1.5rem 1rem 3rem' }}>
      {children}
    </main>
    <footer style={{ borderTop: '1px solid var(--border)', background: '#fff' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <span>CaribWayz — Navigate Together</span>
        <a href="mailto:support@caribwayz.com" style={{ color: '#0E7AC4' }}>support@caribwayz.com</a>
      </div>
    </footer>
  </div>
);

export default PublicLayout;
