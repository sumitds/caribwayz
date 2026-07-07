import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getBusinesses, addBusiness, updateBusiness } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Modal from '../../components/UI/Modal';
import { MdAdd, MdBusiness, MdStar } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

const TIERS = [
  { key: 'journey', label: 'Journey', color: '#888', desc: 'Proximity targeting, map listing, verified badge' },
  { key: 'stride', label: 'Stride', color: '#F5A623', desc: 'Journey + In-app promotions, geo-triggers, custom profile' },
  { key: 'wayz_up', label: 'Wayz Up', color: '#CC2229', desc: 'Stride + Group visibility, offline tools, monthly insights' },
];

const SIZES = ['small', 'medium', 'large'];

const selectStyle = {
  background: 'var(--bg-input)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text)',
  padding: '0.65rem 0.9rem', fontSize: '0.93rem', width: '100%',
};

const AdminBusinesses = () => {
  const [tierFilter, setTierFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', category: '', latitude: '', longitude: '', address: '', phone: '', website: '', description: '', membership_tier: 'journey', business_size: 'small' });
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-businesses', tierFilter],
    queryFn: () => getBusinesses(tierFilter !== 'all' ? { tier: tierFilter } : {}),
    select: (res) => res.data.data.businesses,
  });

  const addMutation = useMutation({
    mutationFn: addBusiness,
    onSuccess: () => {
      queryClient.invalidateQueries(['admin-businesses']);
      queryClient.invalidateQueries(['admin-stats']);
      toast.success('Business added!');
      setShowAdd(false);
      setForm({ name: '', category: '', latitude: '', longitude: '', address: '', phone: '', website: '', description: '', membership_tier: 'journey', business_size: 'small' });
    },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to add business'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateBusiness(id, data),
    onSuccess: () => { queryClient.invalidateQueries(['admin-businesses']); toast.success('Business updated'); },
  });

  const handleAdd = (e) => {
    e.preventDefault();
    if (!form.name || !form.latitude || !form.longitude) return toast.error('Name and coordinates required');
    addMutation.mutate(form);
  };

  const getTierMeta = (key) => TIERS.find((t) => t.key === key) || TIERS[0];

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <MdBusiness size={26} color="#F5A623" /> Business Listings
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
            Manage Journey, Stride, and Wayz Up membership businesses
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}><MdAdd size={18} /> Add Business</Button>
      </div>

      {/* Tier summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {TIERS.map(({ key, label, color, desc }) => (
          <button
            key={key}
            onClick={() => setTierFilter(tierFilter === key ? 'all' : key)}
            style={{
              background: tierFilter === key ? `${color}18` : 'var(--bg-card)',
              border: `1px solid ${tierFilter === key ? color : 'var(--border)'}`,
              borderRadius: 'var(--radius)', padding: '0.9rem 1.1rem',
              cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.3rem' }}>
              <MdStar size={16} color={color} />
              <span style={{ fontSize: '0.9rem', fontWeight: 700, color }}>{label}</span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{desc}</div>
          </button>
        ))}
      </div>

      {/* Filter */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.2rem' }}>
        {['all', ...TIERS.map((t) => t.key)].map((k) => (
          <button key={k} onClick={() => setTierFilter(k)} style={{
            padding: '0.3rem 0.85rem', borderRadius: 20, border: 'none', cursor: 'pointer',
            background: tierFilter === k ? '#CC2229' : 'var(--bg-card)',
            color: tierFilter === k ? '#fff' : 'var(--text-muted)',
            fontSize: '0.8rem', fontWeight: 600, textTransform: 'capitalize',
          }}>
            {k === 'all' ? 'All' : k.replace('_', ' ')}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading...</div>
      ) : data?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
          <MdBusiness size={48} style={{ marginBottom: '1rem', opacity: 0.3 }} />
          <p>No businesses in this tier</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
          {data?.map((b) => {
            const tier = getTierMeta(b.membership_tier);
            return (
              <div key={b.id} style={{ background: 'var(--bg-card)', border: `1px solid ${tier.color}33`, borderRadius: 'var(--radius)', padding: '1.2rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.97rem' }}>{b.name}</div>
                    {b.category && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'capitalize', marginTop: '0.1rem' }}>{b.category}</div>}
                  </div>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: tier.color, background: `${tier.color}18`, padding: '0.2rem 0.55rem', borderRadius: 20, textTransform: 'capitalize', flexShrink: 0 }}>
                    {tier.label}
                  </span>
                </div>
                {b.address && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>{b.address}</div>}
                {b.phone && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>{b.phone}</div>}
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '0.75rem', textTransform: 'capitalize' }}>
                  {b.business_size} · {formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {TIERS.filter((t) => t.key !== b.membership_tier).map((t) => (
                    <button key={t.key} onClick={() => updateMutation.mutate({ id: b.id, data: { membership_tier: t.key } })}
                      style={{ fontSize: '0.72rem', padding: '0.2rem 0.55rem', borderRadius: 20, border: `1px solid ${t.color}55`, background: 'none', color: t.color, cursor: 'pointer' }}>
                      → {t.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <Modal title="Add Business Listing" onClose={() => setShowAdd(false)}>
          <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <Input label="Business Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input label="Category" placeholder="e.g. restaurant, gas station, hotel" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Membership Tier</label>
                <select value={form.membership_tier} onChange={(e) => setForm({ ...form, membership_tier: e.target.value })} style={selectStyle}>
                  {TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Size</label>
                <select value={form.business_size} onChange={(e) => setForm({ ...form, business_size: e.target.value })} style={selectStyle}>
                  {SIZES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <Input label="Latitude *" value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} />
              <Input label="Longitude *" value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} />
            </div>
            <Input label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input label="Website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            <Button type="submit" fullWidth loading={addMutation.isPending}>Add Business</Button>
          </form>
        </Modal>
      )}
    </Layout>
  );
};

export default AdminBusinesses;
