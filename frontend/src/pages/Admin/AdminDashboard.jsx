import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getDashboardStats } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import { MdPeople, MdRoute, MdWarning, MdSos, MdGroup, MdBusiness, MdCampaign } from 'react-icons/md';

const StatCard = ({ icon: Icon, label, value, color, sub }) => (
  <div style={{
    background: 'var(--bg-card)', border: `1px solid ${color}33`,
    borderRadius: 'var(--radius)', padding: '1.4rem 1.5rem',
    display: 'flex', alignItems: 'center', gap: '1.1rem',
    position: 'relative', overflow: 'hidden',
  }}>
    <div style={{
      position: 'absolute', right: -10, top: -10,
      width: 80, height: 80, borderRadius: '50%',
      background: `${color}0d`,
    }} />
    <div style={{
      width: 48, height: 48, borderRadius: 'var(--radius)',
      background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <Icon size={24} color={color} />
    </div>
    <div>
      <div style={{ fontSize: '2rem', fontWeight: 800, lineHeight: 1, color: '#f0f0f0' }}>{value ?? '—'}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{label}</div>
      {sub && <div style={{ fontSize: '0.72rem', color, marginTop: '0.2rem', fontWeight: 600 }}>{sub}</div>}
    </div>
  </div>
);

const ReportTypeBar = ({ type, count, max }) => {
  const colors = { traffic: '#F5A623', accident: '#CC2229', police: '#3b82f6', construction: '#8b5cf6', hazard: '#ef4444', flood: '#06b6d4', pothole: '#f97316', other: '#888' };
  const color = colors[type] || '#888';
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem' }}>
      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', width: 90, textTransform: 'capitalize', flexShrink: 0 }}>{type}</span>
      <div style={{ flex: 1, height: 8, background: '#252525', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ fontSize: '0.8rem', fontWeight: 700, color, width: 24, textAlign: 'right' }}>{count}</span>
    </div>
  );
};

const AdminDashboard = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: getDashboardStats,
    select: (res) => res.data.data,
    refetchInterval: 30000,
  });

  const maxReportCount = data?.recent_report_types?.length > 0
    ? Math.max(...data.recent_report_types.map((r) => parseInt(r.count)))
    : 1;

  return (
    <Layout>
      <div style={{ marginBottom: '1.75rem' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 800 }}>
          <span style={{ color: '#CC2229' }}>Carib</span><span style={{ color: '#F5A623' }}>Wayz</span> Command Center
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
          Real-time overview of platform activity across the Caribbean
        </p>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>Loading stats...</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
            <StatCard icon={MdPeople}   label="Total Users"        value={data?.total_users}        color="#F5A623" />
            <StatCard icon={MdWarning}  label="Active Reports"     value={data?.active_reports}     color="#CC2229" sub="Community submitted" />
            <StatCard icon={MdSos}      label="Active Emergencies" value={data?.active_emergencies} color="#ef4444" />
            <StatCard icon={MdRoute}    label="Total Routes"       value={data?.total_routes}        color="#2D8C00" />
            <StatCard icon={MdGroup}    label="Groups Active"      value={data?.total_groups}        color="#3b82f6" />
            <StatCard icon={MdBusiness} label="Business Members"   value={data?.active_businesses}  color="#F5A623" />
            <StatCard icon={MdCampaign} label="Broadcasts Sent"    value={data?.total_broadcasts}   color="#CC2229" sub="Island-wide alerts" />
          </div>

          {data?.recent_report_types?.length > 0 && (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.4rem 1.6rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '1.1rem', color: '#F5A623' }}>
                Report Types — Last 7 Days
              </h3>
              {data.recent_report_types.map((r) => (
                <ReportTypeBar key={r.type} type={r.type} count={parseInt(r.count)} max={maxReportCount} />
              ))}
            </div>
          )}
        </>
      )}
    </Layout>
  );
};

export default AdminDashboard;
