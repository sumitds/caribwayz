import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSponsorships, updateSponsorship } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import { MdStorefront, MdCheckCircle, MdCancel, MdSchedule, MdFilterList } from 'react-icons/md';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const STATUS_COLORS = {
  pending:  { color: '#F5A623', bg: '#F5A62318' },
  active:   { color: '#2D8C00', bg: '#2D8C0018' },
  expired:  { color: '#888',    bg: '#88888818' },
  rejected: { color: '#CC2229', bg: '#CC222918' },
};

const STATUSES = ['all', 'pending', 'active', 'expired', 'rejected'];

const Badge = ({ status }) => {
  const m = STATUS_COLORS[status] || STATUS_COLORS.expired;
  return (
    <span style={{
      fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
      color: m.color, background: m.bg, padding: '0.2rem 0.6rem',
      borderRadius: 20, border: `1px solid ${m.color}55`,
    }}>
      {status}
    </span>
  );
};

const AdminSponsorships = () => {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-sponsorships', filter],
    queryFn: () => getSponsorships(filter !== 'all' ? { status: filter } : {}),
    select: (res) => res.data.data,
  });

  const mutation = useMutation({
    mutationFn: ({ id, ...payload }) => updateSponsorship(id, payload),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries(['admin-sponsorships']);
      toast.success(`Sponsorship ${vars.status}`);
      setSelected(null);
    },
    onError: () => toast.error('Action failed'),
  });

  const act = (id, status) => mutation.mutate({ id, status });

  const summary = data?.summary || {};
  const sponsorships = data?.sponsorships || [];

  return (
    <Layout>
      {/* Header */}
      <div style={{ marginBottom: '1.75rem' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <MdStorefront size={26} color="#F5A623" /> Store Sponsorships
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
          Businesses paying $50 to be featured as a sponsored pin on the map
        </p>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Pending', key: 'pending', color: '#F5A623' },
          { label: 'Active', key: 'active', color: '#2D8C00' },
          { label: 'Expired', key: 'expired', color: '#888' },
          { label: 'Rejected', key: 'rejected', color: '#CC2229' },
        ].map(({ label, key, color }) => (
          <div key={key} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1.1rem' }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.35rem' }}>{label}</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 900, color }}>{summary[key] || 0}</div>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <MdFilterList size={18} color="var(--text-muted)" style={{ alignSelf: 'center' }} />
        {STATUSES.map((s) => {
          const m = STATUS_COLORS[s] || {};
          const isActive = filter === s;
          return (
            <button key={s} onClick={() => setFilter(s)} style={{
              padding: '0.3rem 0.85rem', borderRadius: 20, cursor: 'pointer',
              border: `1px solid ${isActive ? (m.color || '#CC2229') : 'var(--border)'}`,
              background: isActive ? (m.bg || '#CC222918') : 'transparent',
              color: isActive ? (m.color || '#CC2229') : 'var(--text-muted)',
              fontWeight: 700, fontSize: '0.78rem', textTransform: 'capitalize',
            }}>
              {s === 'all' ? 'All' : s}
            </button>
          );
        })}
      </div>

      {/* Table */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading sponsorships...</div>
      ) : sponsorships.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <MdStorefront size={44} style={{ opacity: 0.3, marginBottom: '1rem' }} />
          <p>No sponsorships found</p>
        </div>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Business', 'Requested By', 'Amount', 'Payment', 'Status', 'Submitted', 'Actions'].map((h) => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sponsorships.map((s, i) => (
                  <tr key={s.id} style={{ borderBottom: i < sponsorships.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      <div style={{ fontWeight: 700 }}>{s.business_name}</div>
                      {s.business_address && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.business_address}</div>}
                    </td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      <div style={{ fontWeight: 600 }}>{s.user_name || '—'}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.user_email || ''}</div>
                    </td>
                    <td style={{ padding: '0.85rem 1rem', fontWeight: 800, color: '#2D8C00' }}>${parseFloat(s.amount).toFixed(2)}</td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{s.payment_method}</td>
                    <td style={{ padding: '0.85rem 1rem' }}><Badge status={s.status} /></td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {format(new Date(s.created_at), 'dd MMM yyyy')}
                    </td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      {s.status === 'pending' && (
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            onClick={() => act(s.id, 'active')}
                            disabled={mutation.isPending}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.7rem', borderRadius: 6, border: 'none', background: '#2D8C0018', color: '#2D8C00', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem' }}
                          >
                            <MdCheckCircle size={14} /> Approve
                          </button>
                          <button
                            onClick={() => act(s.id, 'rejected')}
                            disabled={mutation.isPending}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.7rem', borderRadius: 6, border: 'none', background: '#CC222918', color: '#CC2229', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem' }}
                          >
                            <MdCancel size={14} /> Reject
                          </button>
                        </div>
                      )}
                      {s.status === 'active' && (
                        <button
                          onClick={() => act(s.id, 'expired')}
                          disabled={mutation.isPending}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.7rem', borderRadius: 6, border: 'none', background: '#88888818', color: '#888', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem' }}
                        >
                          <MdSchedule size={14} /> Expire
                        </button>
                      )}
                      {(s.status === 'expired' || s.status === 'rejected') && (
                        <button
                          onClick={() => act(s.id, 'active')}
                          disabled={mutation.isPending}
                          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.7rem', borderRadius: 6, border: 'none', background: '#2D8C0018', color: '#2D8C00', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem' }}
                        >
                          <MdCheckCircle size={14} /> Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
};

export default AdminSponsorships;
