import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getBroadcasts, createBroadcast, deleteBroadcast } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import { MdCampaign, MdDelete, MdWarning, MdInfo, MdLocalFireDepartment } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

const TYPES = ['disaster', 'hazard', 'emergency', 'road_closure', 'info'];
const SEVERITIES = ['info', 'warning', 'critical'];
const PARISHES = ['Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann', 'Trelawny', 'St. James', 'Hanover', 'Westmoreland', 'St. Elizabeth', 'Manchester', 'Clarendon', 'St. Catherine'];

const severityColor = { info: '#3b82f6', warning: '#F5A623', critical: '#CC2229' };
const typeIcon = { disaster: MdLocalFireDepartment, hazard: MdWarning, emergency: MdWarning, road_closure: MdWarning, info: MdInfo };

const selectStyle = {
  background: 'var(--bg-input)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text)',
  padding: '0.65rem 0.9rem', fontSize: '0.93rem', width: '100%',
};

const AdminBroadcast = () => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ title: '', message: '', type: 'hazard', scope: 'island_wide', parish: '', severity: 'warning' });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-broadcasts'],
    queryFn: getBroadcasts,
    select: (res) => res.data.data.broadcasts,
  });

  const createMutation = useMutation({
    mutationFn: createBroadcast,
    onSuccess: () => {
      queryClient.invalidateQueries(['admin-broadcasts']);
      queryClient.invalidateQueries(['admin-stats']);
      toast.success('Alert broadcast sent island-wide');
      setForm({ title: '', message: '', type: 'hazard', scope: 'island_wide', parish: '', severity: 'warning' });
    },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to broadcast'),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteBroadcast,
    onSuccess: () => { queryClient.invalidateQueries(['admin-broadcasts']); toast.success('Broadcast removed'); },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title.trim() || !form.message.trim()) return toast.error('Title and message are required');
    if (form.scope === 'parish' && !form.parish) return toast.error('Please select a parish');
    createMutation.mutate(form);
  };

  return (
    <Layout>
      <div style={{ marginBottom: '1.75rem' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <MdCampaign size={26} color="#CC2229" /> Broadcast Alert Center
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
          Push island-wide or parish-specific emergency alerts to all CaribWayz users
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'start' }}>
        {/* Compose */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid #CC222933', borderRadius: 'var(--radius)', padding: '1.5rem' }}>
          <h3 style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '1.2rem', color: '#F5A623' }}>Compose Alert</h3>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Alert Title</label>
              <input
                value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Hurricane Warning — All Parishes"
                style={{ ...selectStyle }}
              />
            </div>

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Message</label>
              <textarea
                value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder="Provide clear instructions or information for the public..."
                rows={4}
                style={{ ...selectStyle, resize: 'vertical' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={selectStyle}>
                  {TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Severity</label>
                <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} style={{ ...selectStyle, color: severityColor[form.severity] }}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Coverage</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {['island_wide', 'parish'].map((s) => (
                  <button
                    key={s} type="button"
                    onClick={() => setForm({ ...form, scope: s, parish: '' })}
                    style={{
                      flex: 1, padding: '0.55rem', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer',
                      background: form.scope === s ? '#CC2229' : 'var(--bg-input)',
                      color: form.scope === s ? '#fff' : 'var(--text-muted)',
                      fontWeight: 600, fontSize: '0.85rem', transition: 'all 0.15s',
                    }}
                  >
                    {s === 'island_wide' ? 'Island-Wide' : 'Parish Only'}
                  </button>
                ))}
              </div>
            </div>

            {form.scope === 'parish' && (
              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Select Parish</label>
                <select value={form.parish} onChange={(e) => setForm({ ...form, parish: e.target.value })} style={selectStyle}>
                  <option value="">— Choose Parish —</option>
                  {PARISHES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            )}

            <button
              type="submit"
              disabled={createMutation.isPending}
              style={{
                padding: '0.8rem', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer',
                background: createMutation.isPending ? '#444' : 'linear-gradient(135deg, #CC2229, #a81b21)',
                color: '#fff', fontWeight: 700, fontSize: '0.95rem', letterSpacing: '0.03em',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                transition: 'opacity 0.15s',
              }}
            >
              <MdCampaign size={20} />
              {createMutation.isPending ? 'Sending...' : 'Send Broadcast'}
            </button>
          </form>
        </div>

        {/* History */}
        <div>
          <h3 style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '1rem', color: '#F5A623' }}>Broadcast History</h3>
          {isLoading ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>Loading...</div>
          ) : data?.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '3rem', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
              No broadcasts sent yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem', maxHeight: 520, overflowY: 'auto' }}>
              {data?.map((b) => {
                const Icon = typeIcon[b.type] || MdInfo;
                const color = severityColor[b.severity] || '#888';
                return (
                  <div key={b.id} style={{ background: 'var(--bg-card)', border: `1px solid ${color}33`, borderRadius: 'var(--radius)', padding: '1rem 1.1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                          <Icon size={16} color={color} />
                          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{b.title}</span>
                          <span style={{ fontSize: '0.7rem', fontWeight: 700, color, background: `${color}18`, padding: '0.15rem 0.5rem', borderRadius: 20, textTransform: 'uppercase' }}>{b.severity}</span>
                        </div>
                        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.4rem', lineHeight: 1.4 }}>{b.message}</p>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                          <span style={{ textTransform: 'capitalize' }}>{b.type.replace('_', ' ')}</span>
                          <span>{b.scope === 'island_wide' ? 'Island-Wide' : b.parish}</span>
                          <span>by {b.sent_by || 'Admin'}</span>
                          <span>{formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => deleteMutation.mutate(b.id)}
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.2rem', borderRadius: 6, flexShrink: 0 }}
                        title="Delete"
                      >
                        <MdDelete size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};

export default AdminBroadcast;
