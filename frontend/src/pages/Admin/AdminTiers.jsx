import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMembershipTiers, addMembershipTier, updateMembershipTier } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Modal from '../../components/UI/Modal';
import { MdAdd, MdEdit, MdLayers } from 'react-icons/md';
import toast from 'react-hot-toast';
import { EMPTY_TIER_FORM, tierFormFrom, tierPayload, tierRangeShort, feeLabel, apiMessage } from './memberAdminModel';
import { PageHeader, EmptyState, ErrorState, smallButton } from './memberUi';

const TierForm = ({ initial, submitting, onSubmit, submitLabel }) => {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleSubmit = (e) => {
    e.preventDefault();
    const result = tierPayload(form);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmit(result.body);
  };

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <Input label="Name *" placeholder="e.g. 1-15 employees" value={form.name} onChange={set('name')} error={errors.name} maxLength={100} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Input label="Minimum employees *" inputMode="numeric" value={form.min_employees} onChange={set('min_employees')} error={errors.min_employees} />
        <Input label="Maximum employees (empty = or more)" inputMode="numeric" value={form.max_employees} onChange={set('max_employees')} error={errors.max_employees} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.5rem' }}>
        <Input label="Yearly fee (empty = not set yet)" inputMode="decimal" value={form.annual_fee} onChange={set('annual_fee')} error={errors.annual_fee} />
        <Input label="Currency" value={form.currency} onChange={set('currency')} error={errors.currency} maxLength={3} />
      </div>
      <Input label="Display order (lower shows first)" inputMode="numeric" value={form.sort_order} onChange={set('sort_order')} error={errors.sort_order} />
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
        <input type="checkbox" checked={form.is_provisional} onChange={(e) => setForm({ ...form, is_provisional: e.target.checked })} />
        Provisional (the fee is not final yet)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Active (offered on the membership page)
      </label>
      <Button type="submit" fullWidth loading={submitting}>{submitLabel}</Button>
    </form>
  );
};

const AdminTiers = () => {
  const [editing, setEditing] = useState(null); // null, 'new', or the tier being edited
  const queryClient = useQueryClient();

  const tiersQuery = useQuery({
    queryKey: ['admin-membership-tiers'],
    queryFn: getMembershipTiers,
    select: (res) => res.data.data.tiers,
  });

  const done = (message) => {
    queryClient.invalidateQueries({ queryKey: ['admin-membership-tiers'] });
    toast.success(message);
    setEditing(null);
  };

  const addMutation = useMutation({
    mutationFn: addMembershipTier,
    onSuccess: () => done('Tier added'),
    onError: (err) => toast.error(apiMessage(err, 'Failed to add tier')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateMembershipTier(id, data),
    onSuccess: () => done('Tier updated'),
    onError: (err) => toast.error(apiMessage(err, 'Failed to update tier')),
  });

  const tiers = tiersQuery.data || [];

  return (
    <Layout>
      <PageHeader
        icon={MdLayers}
        title="Membership Tiers"
        subtitle="Yearly fees by number of employees. A new application is quoted the fee of the first active tier its employee count falls in; fees already quoted do not change."
        action={<Button onClick={() => setEditing('new')}><MdAdd size={18} /> Add Tier</Button>}
      />

      {tiersQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading tiers...</div>
      ) : tiersQuery.isError ? (
        <ErrorState message={apiMessage(tiersQuery.error, 'Could not load the tiers.')} onRetry={() => tiersQuery.refetch()} />
      ) : tiers.length === 0 ? (
        <EmptyState icon={MdLayers}><p>No tiers. Add one so businesses can apply.</p></EmptyState>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Tier', 'Employees', 'Yearly fee', 'Order', 'Status', ''].map((h) => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tiers.map((t, i) => (
                  <tr key={t.id} style={{ borderBottom: i < tiers.length - 1 ? '1px solid var(--border)' : 'none', opacity: t.is_active ? 1 : 0.6 }}>
                    <td style={{ padding: '0.85rem 1rem', fontWeight: 700 }}>{t.name}</td>
                    <td style={{ padding: '0.85rem 1rem' }}>{tierRangeShort(t)}</td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      <span style={{ fontWeight: 800, color: t.annual_fee === null ? '#888' : '#2D8C00' }}>{feeLabel(t.annual_fee, t.currency)}</span>
                      {t.is_provisional && <span style={{ fontSize: '0.72rem', color: '#B26A00', marginLeft: '0.4rem' }}>provisional</span>}
                    </td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)' }}>{t.sort_order ?? '—'}</td>
                    <td style={{ padding: '0.85rem 1rem', color: t.is_active ? '#2D8C00' : '#888', fontWeight: 700 }}>{t.is_active ? 'Active' : 'Inactive'}</td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      <button type="button" onClick={() => setEditing(t)} style={smallButton('#0E7AC4')}>
                        <MdEdit size={14} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'Add Tier' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <TierForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? { ...EMPTY_TIER_FORM } : tierFormFrom(editing)}
            submitting={addMutation.isPending || updateMutation.isPending}
            submitLabel={editing === 'new' ? 'Add Tier' : 'Save Changes'}
            onSubmit={(body) => (editing === 'new'
              ? addMutation.mutate(body)
              : updateMutation.mutate({ id: editing.id, data: body }))}
          />
        </Modal>
      )}
    </Layout>
  );
};

export default AdminTiers;
