import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  MdMap, MdRoute, MdWarning, MdSos, MdGroup,
  MdPerson, MdDashboard, MdBusiness, MdPeople,
  MdLogout, MdCampaign, MdHandshake, MdShield, MdDescription,
  MdPayments, MdLayers, MdAssignment, MdSettings,
} from 'react-icons/md';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

const userNavItems = [
  { to: '/dashboard', icon: MdMap, label: 'Map & Navigation' },
  { to: '/routes', icon: MdRoute, label: 'My Routes' },
  { to: '/reports', icon: MdWarning, label: 'Reports' },
  { to: '/emergency', icon: MdSos, label: 'Emergency' },
  { to: '/groups', icon: MdGroup, label: 'Group Navigation' },
  { to: '/record', icon: MdDescription, label: 'Record' },
  { to: '/profile', icon: MdPerson, label: 'Profile' },
];

const adminNavItems = [
  { to: '/admin', icon: MdDashboard, label: 'Dashboard' },
  { to: '/desk', icon: MdSos, label: 'Emergency Desk' },
  { to: '/admin/broadcast', icon: MdCampaign, label: 'Broadcast Alerts' },
  { to: '/admin/reports', icon: MdWarning, label: 'Moderate Reports' },
  { to: '/admin/users', icon: MdPeople, label: 'Manage Users' },
  { to: '/admin/businesses', icon: MdBusiness, label: 'Member Businesses' },
  { to: '/admin/membership-applications', icon: MdAssignment, label: 'Membership Applications' },
  { to: '/admin/membership-tiers', icon: MdLayers, label: 'Membership Tiers' },
  { to: '/admin/membership-settings', icon: MdSettings, label: 'Membership Settings' },
  { to: '/admin/partners', icon: MdHandshake, label: 'Partners' },
  { to: '/admin/payouts', icon: MdPayments, label: 'Driver Payouts' },
];

const Sidebar = () => {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    toast.success('Logged out successfully');
    navigate('/login');
  };

  // Responders work the emergency desk; it sits first so it is one click away.
  const navItems = isAdmin
    ? adminNavItems
    : user?.is_responder
      ? [{ to: '/desk', icon: MdSos, label: 'Emergency Desk' }, ...userNavItems]
      : userNavItems;

  const linkStyle = ({ isActive }) => ({
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '0.65rem 1rem', borderRadius: 8,
    color: isActive ? '#D12229' : '#444444',
    background: isActive ? 'rgba(209,34,41,0.08)' : 'transparent',
    fontWeight: isActive ? 700 : 400, fontSize: '0.9rem',
    transition: 'all 0.15s',
    textDecoration: 'none',
  });

  return (
    <aside style={{
      width: 'var(--sidebar-width)', background: 'rgb(220, 242, 220)',
      borderRight: '1px solid rgb(185, 218, 185)', display: 'flex',
      flexDirection: 'column', height: '100vh', position: 'fixed',
      top: 0, left: 0, zIndex: 100,
      boxShadow: '2px 0 10px rgba(0,0,0,0.06)',
    }}>
      {/* Logo */}
      <div style={{ padding: '1.2rem', borderBottom: '1px solid rgb(185, 218, 185)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img src="/logo.jpg" alt="CaribWayz" style={{ width: 44, height: 44, objectFit: 'contain', borderRadius: 8, flexShrink: 0 }} />
          <div>
            <h1 style={{ fontSize: '1.3rem', fontWeight: 900, letterSpacing: '-0.01em' }}>
              <span style={{ color: '#D12229' }}>Ca</span><span style={{ color: '#F5A623' }}>rib</span><span style={{ color: '#3AAA3A' }}>Wa</span><span style={{ color: '#000000' }}>yz</span>
            </h1>
            <p style={{ fontSize: '0.68rem', color: '#666', marginTop: '0.1rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {isAdmin ? 'Admin Panel' : 'Navigate the Caribbean'}
            </p>
          </div>
        </div>
        {isAdmin && (
          <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <MdShield size={12} color="#D12229" />
            <span style={{ fontSize: '0.7rem', color: '#D12229', fontWeight: 700, letterSpacing: '0.05em' }}>ADMIN ACCESS</span>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '1rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.1rem', overflowY: 'auto' }}>
        {isAdmin && (
          <div style={{ padding: '0 0.5rem', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#D12229', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Command Center
            </span>
          </div>
        )}
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === '/admin'} style={linkStyle}>
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User Footer */}
      <div style={{ padding: '1rem 0.75rem', borderTop: '1px solid rgb(185, 218, 185)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', padding: '0 0.5rem' }}>
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            background: 'linear-gradient(135deg, #D12229, #F5A623)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: '0.9rem', color: '#fff',
          }}>
            {user?.name?.[0]?.toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: '0.87rem', fontWeight: 600, color: '#111' }}>{user?.name}</div>
            <div style={{ fontSize: '0.72rem', color: '#666', textTransform: 'capitalize' }}>{user?.role}</div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.6rem',
            width: '100%', background: 'none', border: 'none',
            color: '#666', padding: '0.5rem',
            borderRadius: 8, cursor: 'pointer',
            fontSize: '0.88rem', fontWeight: 500,
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = '#D12229'}
          onMouseLeave={(e) => e.currentTarget.style.color = '#666'}
        >
          <MdLogout size={18} /> Logout
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
