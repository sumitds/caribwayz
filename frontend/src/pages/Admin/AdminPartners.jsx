import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPartners, addPartner, updatePartnerStatus } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Modal from '../../components/UI/Modal';
import Input from '../../components/UI/Input';
import { MdHandshake, MdAdd, MdLocalHospital, MdSecurity, MdElectricBolt, MdBeachAccess } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

const TIERS = [
  { key: 'national_emergency', label: 'National Emergency', icon: MdLocalHospital, color: '#CC2229', desc: 'Ambulance, JCF, JDF, Fire Brigade, ODPEM' },
  { key: 'roadside_safety', label: 'Roadside Safety', icon: MdSecurity, color: '#F5A623', desc: 'Towing, security firms, transit groups' },
  { key: 'infrastructure', label: 'Infrastructure & Utility', icon: MdElectricBolt, color: '#3b82f6', desc: 'Fuel providers, utilities, telecoms' },
  { key: 'tourism', label: 'Tourism & Ecosystem', icon: MdBeachAccess, color: '#2D8C00', desc: 'Hotels, tour operators, car rentals, ports' },
];

const COVERAGE = ['local', 'regional', 'national', 'multi_island'];

const selectStyle = {
  background: 'var(--bg-input)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text)',
  padding: '0.65rem 0.9rem', fontSize: '0.93rem', width: '100%',
};

const AdminPartners = () => {
  const queryClient = useQueryClient();
  const [tierFilter, setTierFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', entity_type: '', tier: 'national_emergency', coverage: 'local', contact_name: '', contact_email: '', contact_phone: '', notes: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-partners', tierFilter],
    queryFn: () => getPartners(tierFilter !== 'all' ? { tier: tierFilter } : {}),
    select: (res) => res.data.data.partners,
  });

  const addMutation = useMutation({
    mutationFn: addPartner,
    onSuccess: () => {
      queryClient.invalidateQueries(['admin-partners']);
      toast.success('Partner added');
      setShowAdd(false);
      setForm({ name: '', entity_type: '', tier: 'national_emergency', coverage: 'local', contact_name: '', contact_email: '', contact_phone: '', notes: '' });
    },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to add partner'),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }) => updatePartnerStatus(id, status),
    onSuccess: (_, { status }) => { queryClient.invalidateQueries(['admin-partners']); toast.success(`Partner ${status}`); },
  });

  const handleAdd = (e) => {
    e.preventDefault();
    if (!form.name || !form.entity_type) return toast.error('Name and entity type are required');
    addMutation.mutate(form);
  };

  const getTierMeta = (key) => TIERS.find((t) => t.key === key) || TIERS[0];

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <MdHandshake size={26} color="#F5A623" /> Partnership Members
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
            Emergency responders, roadside services, utilities, and tourism partners
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <MdAdd size={18} /> Add Partner
        </Button>
      </div>

      {/* Tier summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {TIERS.map(({ key, label, icon: Icon, color, desc }) => (
          <button
            key={key}
            onClick={() => setTierFilter(tierFilter === key ? 'all' : key)}
            style={{
              background: tierFilter === key ? `${color}18` : 'var(--bg-card)',
              border: `1px solid ${tierFilter === key ? color : 'var(--border)'}`,
              borderRadius: 'var(--radius)', padding: '1rem 1.1rem',
              cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <Icon size={18} color={color} />
              <span style={{ fontSize: '0.82rem', fontWeight: 700, color }}>{label}</span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{desc}</div>
          </button>
        ))}
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
        {['all', ...TIERS.map((t) => t.key)].map((k) => (
          <button
            key={k}
            onClick={() => setTierFilter(k)}
            style={{
              padding: '0.3rem 0.85rem', borderRadius: 20, border: 'none', cursor: 'pointer',
              background: tierFilter === k ? '#CC2229' : 'var(--bg-card)',
              color: tierFilter === k ? '#fff' : 'var(--text-muted)',
              fontSize: '0.8rem', fontWeight: 600, textTransform: 'capitalize',
            }}
          >
            {k === 'all' ? 'All Partners' : k.replace('_', ' ')}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading partners...</div>
      ) : data?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
          <MdHandshake size={40} style={{ opacity: 0.3, marginBottom: '0.75rem' }} />
          <p>No partners in this tier yet</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.85rem' }}>
          {data?.map((p) => {
            const tier = getTierMeta(p.tier);
            const Icon = tier.icon;
            const statusColor = p.status === 'active' ? '#2D8C00' : p.status === 'pending' ? '#F5A623' : '#888';
            return (
              <div key={p.id} style={{ background: 'var(--bg-card)', border: `1px solid ${tier.color}33`, borderRadius: 'var(--radius)', padding: '1.1rem 1.2rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.6rem' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Icon size={16} color={tier.color} />
                      <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{p.name}</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: tier.color, marginTop: '0.15rem' }}>{p.entity_type}</div>
                  </div>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: statusColor, background: `${statusColor}18`, padding: '0.2rem 0.55rem', borderRadius: 20, textTransform: 'capitalize', flexShrink: 0 }}>
                    {p.status}
                  </span>
                </div>

                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.75rem' }}>
                  {p.contact_name && <span>Contact: {p.contact_name}</span>}
                  {p.contact_email && <span>{p.contact_email}</span>}
                  {p.contact_phone && <span>{p.contact_phone}</span>}
                  <span style={{ textTransform: 'capitalize' }}>Coverage: {p.coverage.replace('_', ' ')}</span>
                  <span>Added {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}</span>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {p.status !== 'active' && (
                    <Button size="sm" variant="success" loading={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: p.id, status: 'active' })}>
                      Activate
                    </Button>
                  )}
                  {p.status === 'active' && (
                    <Button size="sm" variant="secondary" loading={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: p.id, status: 'inactive' })}>
                      Deactivate
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <Modal title="Add Partnership Member" onClose={() => setShowAdd(false)}>
          <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <Input label="Organization Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Jamaica Fire Brigade" />
            <Input label="Entity Type *" value={form.entity_type} onChange={(e) => setForm({ ...form, entity_type: e.target.value })} placeholder="e.g. Fire Brigade, Towing Company" />

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Partnership Tier</label>
              <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })} style={selectStyle}>
                {TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Coverage</label>
              <select value={form.coverage} onChange={(e) => setForm({ ...form, coverage: e.target.value })} style={selectStyle}>
                {COVERAGE.map((c) => <option key={c} value={c}>{c.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}</option>)}
              </select>
            </div>

            <Input label="Contact Name" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
            <Input label="Contact Email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
            <Input label="Contact Phone" value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />

            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notes</label>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} style={{ ...selectStyle, resize: 'vertical' }} />
            </div>

            <Button type="submit" fullWidth loading={addMutation.isPending}>Add Partner</Button>
          </form>
        </Modal>
      )}
    </Layout>
  );
};

export default AdminPartners;
