import React from 'react';

const colorMap = {
  active: '#22c55e', expired: '#94a3b8', removed: '#ef4444',
  planned: '#0ea5e9', 'in-progress': '#f59e0b', completed: '#22c55e', cancelled: '#ef4444',
  critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#22c55e',
  admin: '#a855f7', user: '#0ea5e9',
  traffic: '#f59e0b', accident: '#ef4444', police: '#3b82f6', construction: '#f97316',
  hazard: '#ef4444', fire: '#ef4444', medical: '#22c55e', breakdown: '#f59e0b',
};

const Badge = ({ label, status }) => {
  const color = colorMap[status] || colorMap[label?.toLowerCase()] || '#94a3b8';
  return (
    <span style={{
      background: `${color}22`,
      color,
      border: `1px solid ${color}44`,
      borderRadius: '20px',
      padding: '0.18rem 0.7rem',
      fontSize: '0.75rem',
      fontWeight: 600,
      textTransform: 'capitalize',
    }}>
      {label || status}
    </span>
  );
};

export default Badge;
