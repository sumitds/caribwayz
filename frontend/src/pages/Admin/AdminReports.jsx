import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAdminReports, removeReport } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Badge from '../../components/UI/Badge';
import { MdWarning, MdDelete } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

const STATUS_FILTERS = ['active', 'expired', 'removed'];
const TYPE_FILTERS = ['all', 'traffic', 'accident', 'police', 'construction', 'hazard', 'flood', 'pothole'];

const severityColor = { low: '#2D8C00', medium: '#F5A623', high: '#f97316', critical: '#CC2229' };

const AdminReports = () => {
  const [statusFilter, setStatusFilter] = useState('active');
  const [typeFilter, setTypeFilter] = useState('all');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-reports', statusFilter, typeFilter],
    queryFn: () => getAdminReports({ status: statusFilter, type: typeFilter !== 'all' ? typeFilter : undefined }),
    select: (res) => res.data.data.reports,
  });

  const removeMutation = useMutation({
    mutationFn: removeReport,
    onSuccess: () => { queryClient.invalidateQueries(['admin-reports']); queryClient.invalidateQueries(['admin-stats']); toast.success('Report removed'); },
    onError: () => toast.error('Failed to remove report'),
  });

  return (
    <Layout>
      <div style={{ marginBottom: '1.75rem' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <MdWarning size={26} color="#F5A623" /> Moderate Community Reports
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
          Review, escalate, or remove user-submitted road incident reports
        </p>
      </div>

      {/* Status filter */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {STATUS_FILTERS.map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: '0.35rem 1rem', borderRadius: 20, border: 'none', cursor: 'pointer',
            background: statusFilter === s ? '#CC2229' : 'var(--bg-card)',
            color: statusFilter === s ? '#fff' : 'var(--text-muted)',
            fontWeight: 600, fontSize: '0.82rem', textTransform: 'capitalize',
          }}>
            {s}
          </button>
        ))}
      </div>

      {/* Type filter */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
        {TYPE_FILTERS.map((t) => (
          <button key={t} onClick={() => setTypeFilter(t)} style={{
            padding: '0.25rem 0.75rem', borderRadius: 20, border: `1px solid ${typeFilter === t ? '#F5A623' : 'var(--border)'}`,
            cursor: 'pointer', background: typeFilter === t ? '#F5A62318' : 'transparent',
            color: typeFilter === t ? '#F5A623' : 'var(--text-muted)',
            fontWeight: 600, fontSize: '0.78rem', textTransform: 'capitalize',
          }}>
            {t}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading reports...</div>
      ) : data?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
          No {statusFilter} reports found
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          {data?.map((report) => {
            const color = severityColor[report.severity] || '#888';
            return (
              <div key={report.id} style={{ background: 'var(--bg-card)', border: `1px solid ${color}33`, borderRadius: 'var(--radius)', padding: '1.1rem 1.3rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, textTransform: 'capitalize', fontSize: '0.95rem' }}>{report.type}</span>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color, background: `${color}18`, padding: '0.15rem 0.5rem', borderRadius: 20, textTransform: 'capitalize' }}>{report.severity}</span>
                    <Badge status={report.status} label={report.status} />
                  </div>
                  {report.description && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.4rem', lineHeight: 1.4 }}>{report.description}</p>
                  )}
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    <span>By {report.reporter_name}</span>
                    <span>{formatDistanceToNow(new Date(report.created_at), { addSuffix: true })}</span>
                    <span>{report.confirmed_count} confirmations</span>
                    <span style={{ fontFamily: 'monospace' }}>{parseFloat(report.latitude).toFixed(4)}, {parseFloat(report.longitude).toFixed(4)}</span>
                  </div>
                </div>
                {report.status === 'active' && (
                  <Button size="sm" variant="danger" loading={removeMutation.isPending} onClick={() => removeMutation.mutate(report.id)}>
                    <MdDelete size={14} /> Remove
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Layout>
  );
};

export default AdminReports;
