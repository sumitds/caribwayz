import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getBusinesses, addBusiness, updateBusiness, getMembershipTiers } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Modal from '../../components/UI/Modal';
import LocationPicker from '../../components/UI/LocationPicker';
import {
  MdAdd, MdBusiness, MdEdit, MdLocalOffer, MdPause, MdPlace, MdPlayArrow, MdVisibility, MdVisibilityOff,
} from 'react-icons/md';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import {
  MEMBERSHIP_STATUSES, EMPTY_BUSINESS_FORM, businessFormFrom, businessPayload, isShownOnMap, isPromoLive,
  tierRangeShort, apiMessage, suspensionAction,
} from './memberAdminModel';
import {
  StatusPill, Field, FilterChips, PageHeader, EmptyState, ErrorState, selectStyle, textareaStyle, smallButton,
} from './memberUi';

const when = (iso) => (iso ? format(new Date(iso), 'dd MMM yyyy, HH:mm') : null);

const BusinessForm = ({ initial, tiers, submitting, onSubmit, submitLabel }) => {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleSubmit = (e) => {
    e.preventDefault();
    const result = businessPayload(form);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmit(result.body);
  };

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Input label="Name shown in the app *" value={form.name} onChange={set('name')} error={errors.name} maxLength={255} />
        <Input label="Registered business name" value={form.registered_name} onChange={set('registered_name')} error={errors.registered_name} maxLength={200} />
      </div>
      <Input label="Category" placeholder="e.g. restaurant, gas station, hotel" value={form.category} onChange={set('category')} maxLength={100} />

      <LocationPicker
        latitude={form.latitude}
        longitude={form.longitude}
        onPick={(latitude, longitude) => setForm({ ...form, latitude: String(latitude), longitude: String(longitude) })}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Input label="Latitude *" inputMode="decimal" value={form.latitude} onChange={set('latitude')} error={errors.latitude} />
        <Input label="Longitude *" inputMode="decimal" value={form.longitude} onChange={set('longitude')} error={errors.longitude} />
      </div>
      <Input label="Address" value={form.address} onChange={set('address')} maxLength={1000} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Input label="Phone" type="tel" value={form.phone} onChange={set('phone')} maxLength={40} />
        <Input label="Website" value={form.website} onChange={set('website')} error={errors.website} maxLength={1000} />
      </div>
      <Field label="Description" htmlFor="business-description">
        <textarea id="business-description" rows={3} value={form.description} onChange={set('description')} maxLength={5000} style={textareaStyle} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Input label="Business email" type="email" value={form.business_email} onChange={set('business_email')} error={errors.business_email} />
        <Input label="Employees" inputMode="numeric" value={form.employee_count} onChange={set('employee_count')} error={errors.employee_count} />
      </div>

      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <legend style={{ fontSize: '0.82rem', fontWeight: 700, padding: '0 0.3rem' }}>Owner or representative (not shown in the app)</legend>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <Input label="Name" value={form.contact_name} onChange={set('contact_name')} error={errors.contact_name} maxLength={200} />
          <Input label="Position" value={form.contact_position} onChange={set('contact_position')} error={errors.contact_position} maxLength={100} />
          <Input label="Phone" type="tel" value={form.contact_phone} onChange={set('contact_phone')} error={errors.contact_phone} maxLength={40} />
          <Input label="Email" type="email" value={form.contact_email} onChange={set('contact_email')} error={errors.contact_email} />
        </div>
      </fieldset>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Field label="Membership tier" htmlFor="business-tier">
          <select id="business-tier" value={form.tier_id} onChange={set('tier_id')} style={selectStyle}>
            <option value="">No tier</option>
            {tiers.map((t) => (
              <option key={t.id} value={String(t.id)}>{t.name} ({tierRangeShort(t)}){t.is_active ? '' : ' - inactive'}</option>
            ))}
          </select>
        </Field>
        <Field label="Membership status" htmlFor="business-status" error={errors.membership_status}>
          <select id="business-status" value={form.membership_status} onChange={set('membership_status')} style={{ ...selectStyle, textTransform: 'capitalize' }}>
            {MEMBERSHIP_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
      </div>
      <Input label="Membership expires (empty = no expiry)" type="datetime-local" value={form.membership_expires_at}
        onChange={set('membership_expires_at')} error={errors.membership_expires_at} />

      <Field label="Promotion or discount (spoken in the app, at most 280 characters)" htmlFor="business-promo" error={errors.promo_text}>
        <textarea id="business-promo" rows={2} value={form.promo_text} onChange={set('promo_text')} maxLength={280} style={textareaStyle}
          placeholder="e.g. 10% off for CaribWayz drivers" />
      </Field>
      <Input label="Promotion ends (empty = runs until removed)" type="datetime-local" value={form.promo_expires_at}
        onChange={set('promo_expires_at')} error={errors.promo_expires_at} />

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Listed (unticked hides it from the app whatever its status)
      </label>

      <Button type="submit" fullWidth loading={submitting}>{submitLabel}</Button>
    </form>
  );
};

const AdminBusinesses = () => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [editing, setEditing] = useState(null); // null, 'new', or the business being edited
  const queryClient = useQueryClient();

  const businessesQuery = useQuery({
    queryKey: ['admin-businesses', statusFilter],
    queryFn: () => getBusinesses(statusFilter !== 'all' ? { membership_status: statusFilter } : {}),
    select: (res) => res.data.data.businesses,
  });

  const tiersQuery = useQuery({
    queryKey: ['admin-membership-tiers'],
    queryFn: getMembershipTiers,
    select: (res) => res.data.data.tiers,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-businesses'] });
    queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
  };

  const addMutation = useMutation({
    mutationFn: addBusiness,
    onSuccess: () => { refresh(); toast.success('Business added'); setEditing(null); },
    onError: (err) => toast.error(apiMessage(err, 'Failed to add business')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateBusiness(id, data),
    onSuccess: (res) => { refresh(); toast.success(res?.data?.message || 'Business updated'); setEditing(null); },
    onError: (err) => toast.error(apiMessage(err, 'Failed to update business')),
  });

  const businesses = businessesQuery.data || [];
  const tiers = tiersQuery.data || [];
  const now = new Date();

  return (
    <Layout>
      <PageHeader
        icon={MdBusiness}
        title="Member Businesses"
        subtitle="Businesses that pay a yearly membership. Active, listed and unexpired members show on the map and are announced to drivers nearby."
        action={<Button onClick={() => setEditing('new')}><MdAdd size={18} /> Add Business</Button>}
      />

      <FilterChips options={['all', ...MEMBERSHIP_STATUSES]} value={statusFilter} onChange={setStatusFilter} />

      {businessesQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading businesses...</div>
      ) : businessesQuery.isError ? (
        <ErrorState message={apiMessage(businessesQuery.error, 'Could not load the businesses.')} onRetry={() => businessesQuery.refetch()} />
      ) : businesses.length === 0 ? (
        <EmptyState icon={MdBusiness}>
          <p>{statusFilter === 'all' ? 'No member businesses yet. Add one, or activate a paid application.' : `No ${statusFilter} businesses.`}</p>
        </EmptyState>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '1rem' }}>
          {businesses.map((b) => {
            const onMap = isShownOnMap(b, now);
            const promoLive = isPromoLive(b, now);
            return (
              <div key={b.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.97rem' }}>{b.name}</div>
                    {b.category && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'capitalize', marginTop: '0.1rem' }}>{b.category}</div>}
                  </div>
                  <StatusPill status={b.membership_status} />
                </div>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: onMap ? '#2D8C00' : '#888', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <MdPlace size={14} /> {onMap ? 'Shown on the map' : 'Not shown on the map'}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {b.tier_name || 'No tier'}
                  {b.employee_count ? ` · ${b.employee_count} employees` : ''}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {b.membership_expires_at ? `Expires ${when(b.membership_expires_at)}` : 'No expiry set'}
                </div>
                {b.promo_text && (
                  <div style={{ fontSize: '0.8rem', display: 'flex', gap: '0.3rem', alignItems: 'flex-start', color: promoLive ? '#B26A00' : '#888' }}>
                    <MdLocalOffer size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                      {b.promo_text}
                      {b.promo_expires_at && ` (${promoLive ? 'until' : 'ended'} ${when(b.promo_expires_at)})`}
                    </span>
                  </div>
                )}
                {b.address && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{b.address}</div>}
                {b.phone && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{b.phone}</div>}
                {b.registered_name && b.registered_name !== b.name && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Registered as {b.registered_name}</div>
                )}
                {b.contact_name && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Contact: {b.contact_name}{b.contact_position ? ` (${b.contact_position})` : ''}{b.contact_phone ? `, ${b.contact_phone}` : ''}
                  </div>
                )}
                {b.membership_status === 'suspended' && (
                  <div style={{ fontSize: '0.8rem', color: '#7B3FA0', fontWeight: 700 }}>Suspended: hidden from the app, and renewals wait until it is lifted.</div>
                )}
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                  <button type="button" onClick={() => setEditing(b)} style={smallButton('#0E7AC4')}>
                    <MdEdit size={14} /> Edit
                  </button>
                  <button
                    type="button"
                    disabled={updateMutation.isPending}
                    onClick={() => updateMutation.mutate({ id: b.id, data: { is_active: b.is_active === false } })}
                    style={smallButton('#888888')}
                  >
                    {b.is_active === false ? <><MdVisibility size={14} /> List</> : <><MdVisibilityOff size={14} /> Unlist</>}
                  </button>
                  {suspensionAction(b) && (
                    <button
                      type="button"
                      disabled={updateMutation.isPending}
                      onClick={() => updateMutation.mutate({ id: b.id, data: { membership_status: suspensionAction(b).status } })}
                      style={smallButton(b.membership_status === 'suspended' ? '#2D8C00' : '#7B3FA0')}
                    >
                      {b.membership_status === 'suspended' ? <MdPlayArrow size={14} /> : <MdPause size={14} />} {suspensionAction(b).label}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'Add Member Business' : `Edit ${editing.name}`} onClose={() => setEditing(null)} width="620px">
          <BusinessForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? { ...EMPTY_BUSINESS_FORM } : businessFormFrom(editing)}
            tiers={tiers}
            submitting={addMutation.isPending || updateMutation.isPending}
            submitLabel={editing === 'new' ? 'Add Business' : 'Save Changes'}
            onSubmit={(body) => (editing === 'new'
              ? addMutation.mutate(body)
              : updateMutation.mutate({ id: editing.id, data: body }))}
          />
        </Modal>
      )}
    </Layout>
  );
};

export default AdminBusinesses;
