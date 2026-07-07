import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPayouts, updatePayout } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import { MdPayments, MdCheckCircle, MdCancel, MdFilterList, MdAccountBalanceWallet } from 'react-icons/md';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const STATUS_COLORS = {
  pending:  { color: '#F5A623', bg: '#F5A62318' },
  paid:     { color: '#2D8C00', bg: '#2D8C0018' },
  rejected: { color: '#CC2229', bg: '#CC222918' },
};

const STATUSES = ['all', 'pending', 'paid', 'rejected'];

const METHOD_ICONS = { paypal: '🅿', card: '💳' };

const Badge = ({ status }) => {
  const m = STATUS_COLORS[status] || STATUS_COLORS.pending;
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

const AdminPayouts = () => {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-payouts', filter],
    queryFn: () => getPayouts(filter !== 'all' ? { status: filter } : {}),
    select: (res) => res.data.data,
  });

  const mutation = useMutation({
    mutationFn: ({ id, ...payload }) => updatePayout(id, payload),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries(['admin-payouts']);
      toast.success(`Payout marked as ${vars.status}`);
    },
    onError: () => toast.error('Action failed'),
  });

  const act = (id, status) => mutation.mutate({ id, status });

  const summary = data?.summary || {};
  const payouts = data?.payouts || [];

  const pendingTotal = summary.pending?.total || 0;
  const paidTotal = summary.paid?.total || 0;

  return (
    <Layout>
      {/* Header */}
      <div style={{ marginBottom: '1.75rem' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <MdPayments size={26} color="#F5A623" /> Driver Payouts
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
          Cash-out requests from drivers — approve to release earnings via PayPal or card
        </p>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid #F5A62355', borderRadius: 'var(--radius)', padding: '0.9rem 1.1rem' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.35rem' }}>Pending Requests</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 900, color: '#F5A623' }}>{summary.pending?.count || 0}</div>
          <div style={{ fontSize: '0.8rem', color: '#F5A623', marginTop: '0.2rem' }}>${pendingTotal.toFixed(2)} owed</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid #2D8C0055', borderRadius: 'var(--radius)', padding: '0.9rem 1.1rem' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.35rem' }}>Total Paid Out</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 900, color: '#2D8C00' }}>{summary.paid?.count || 0}</div>
          <div style={{ fontSize: '0.8rem', color: '#2D8C00', marginTop: '0.2rem' }}>${paidTotal.toFixed(2)} disbursed</div>
        </div>
        <div style={{ background: 'var(--bg-card)', border: '1px solid #CC222933', borderRadius: 'var(--radius)', padding: '0.9rem 1.1rem' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.35rem' }}>Rejected</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 900, color: '#CC2229' }}>{summary.rejected?.count || 0}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>${(summary.rejected?.total || 0).toFixed(2)}</div>
        </div>
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
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading payouts...</div>
      ) : payouts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          <MdAccountBalanceWallet size={44} style={{ opacity: 0.3, marginBottom: '1rem' }} />
          <p>No payout requests found</p>
        </div>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Driver', 'Amount', 'Method', 'Account', 'Status', 'Requested', 'Processed By', 'Actions'].map((h) => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payouts.map((p, i) => (
                  <tr key={p.id} style={{ borderBottom: i < payouts.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      <div style={{ fontWeight: 700 }}>{p.user_name || '—'}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{p.user_email || ''}</div>
                    </td>
                    <td style={{ padding: '0.85rem 1rem', fontWeight: 900, fontSize: '1rem', color: '#F5A623' }}>
                      ${parseFloat(p.amount).toFixed(2)}
                    </td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', textTransform: 'capitalize', color: 'var(--text-muted)' }}>
                        {METHOD_ICONS[p.method] || '💰'} {p.method}
                      </span>
                    </td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                      {p.account_detail || '—'}
                    </td>
                    <td style={{ padding: '0.85rem 1rem' }}><Badge status={p.status} /></td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {format(new Date(p.requested_at), 'dd MMM yyyy')}
                    </td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                      {p.processed_by_name || '—'}
                      {p.processed_at && (
                        <div style={{ fontSize: '0.72rem' }}>{format(new Date(p.processed_at), 'dd MMM')}</div>
                      )}
                    </td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      {p.status === 'pending' && (
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            onClick={() => act(p.id, 'paid')}
                            disabled={mutation.isPending}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.7rem', borderRadius: 6, border: 'none', background: '#2D8C0018', color: '#2D8C00', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem' }}
                          >
                            <MdCheckCircle size={14} /> Mark Paid
                          </button>
                          <button
                            onClick={() => act(p.id, 'rejected')}
                            disabled={mutation.isPending}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.7rem', borderRadius: 6, border: 'none', background: '#CC222918', color: '#CC2229', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem' }}
                          >
                            <MdCancel size={14} /> Reject
                          </button>
                        </div>
                      )}
                      {p.status !== 'pending' && p.note && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>{p.note}</span>
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

export default AdminPayouts;
