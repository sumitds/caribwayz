import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getMembershipApplications, updateMembershipApplication, activateMembershipApplication,
} from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Modal from '../../components/UI/Modal';
import LocationPicker from '../../components/UI/LocationPicker';
import { MdAssignment, MdCheckCircle, MdCancel, MdReceipt, MdNotes, MdUndo } from 'react-icons/md';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { APPLICATION_STATUSES, activationPayload, feeLabel, apiMessage } from './memberAdminModel';
import { StatusPill, Field, FilterChips, PageHeader, EmptyState, ErrorState, textareaStyle, smallButton } from './memberUi';

const ActivateForm = ({ application, submitting, onSubmit }) => {
  const [form, setForm] = useState({
    latitude: application.latitude === null ? '' : String(application.latitude),
    longitude: application.longitude === null ? '' : String(application.longitude),
    months: '12',
  });
  const [errors, setErrors] = useState({});
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const renewing = Boolean(application.business_id);

  const handleSubmit = (e) => {
    e.preventDefault();
    const result = activationPayload(form);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    if (!renewing && result.body.latitude === undefined) {
      setErrors({ latitude: 'Place the business on the map, or type its coordinates' });
      return;
    }
    setErrors({});
    onSubmit(result.body);
  };

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {renewing
          ? 'This application already has a member listing. Activating renews it: active from now for the months below. Leave the location empty to keep it.'
          : 'Use this once the business has paid. It creates the member listing, active from now for the months below, and marks the application paid.'}
      </p>
      <LocationPicker
        latitude={form.latitude}
        longitude={form.longitude}
        onPick={(latitude, longitude) => setForm({ ...form, latitude: String(latitude), longitude: String(longitude) })}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Input label={renewing ? 'Latitude' : 'Latitude *'} inputMode="decimal" value={form.latitude} onChange={set('latitude')} error={errors.latitude} />
        <Input label={renewing ? 'Longitude' : 'Longitude *'} inputMode="decimal" value={form.longitude} onChange={set('longitude')} error={errors.longitude} />
      </div>
      <Input label="Months of membership" inputMode="numeric" value={form.months} onChange={set('months')} error={errors.months} />
      <Button type="submit" fullWidth loading={submitting}>
        <MdCheckCircle size={18} /> {renewing ? 'Renew Membership' : 'Activate Membership'}
      </Button>
    </form>
  );
};

const NotesForm = ({ application, submitting, onSubmit }) => {
  const [notes, setNotes] = useState(application.admin_notes || '');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(notes.trim() === '' ? null : notes); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <Field label="Notes for the team (not shown to the business)" htmlFor="application-notes">
        <textarea id="application-notes" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} style={textareaStyle}
          placeholder="e.g. Invoice 0012 sent 30 Oct" />
      </Field>
      <Button type="submit" fullWidth loading={submitting}>Save Notes</Button>
    </form>
  );
};

const Detail = ({ label, children }) => (children ? (
  <div style={{ fontSize: '0.8rem' }}>
    <span style={{ color: 'var(--text-muted)' }}>{label}: </span>{children}
  </div>
) : null);

const AdminApplications = () => {
  const [filter, setFilter] = useState('new');
  const [activating, setActivating] = useState(null);
  const [noting, setNoting] = useState(null);
  const queryClient = useQueryClient();

  const applicationsQuery = useQuery({
    queryKey: ['admin-membership-applications', filter],
    queryFn: () => getMembershipApplications(filter !== 'all' ? { status: filter } : {}),
    select: (res) => res.data.data,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-membership-applications'] });
    queryClient.invalidateQueries({ queryKey: ['admin-businesses'] });
  };

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateMembershipApplication(id, data),
    onSuccess: () => { refresh(); toast.success('Application updated'); setNoting(null); },
    onError: (err) => toast.error(apiMessage(err, 'Failed to update the application')),
  });

  const activateMutation = useMutation({
    mutationFn: ({ id, data }) => activateMembershipApplication(id, data),
    onSuccess: (res) => { refresh(); toast.success(res.data.message || 'Membership activated'); setActivating(null); },
    onError: (err) => toast.error(apiMessage(err, 'Failed to activate the membership')),
  });

  const applications = applicationsQuery.data?.applications || [];
  const summary = applicationsQuery.data?.summary || {};
  const counts = { ...summary, all: Object.values(summary).reduce((a, b) => a + b, 0) };
  const setStatus = (a, status) => updateMutation.mutate({ id: a.id, data: { status } });

  return (
    <Layout>
      <PageHeader
        icon={MdAssignment}
        title="Membership Applications"
        subtitle="Businesses that applied on the public membership page. Send the invoice, mark it invoiced, then activate the membership once it is paid."
      />

      <FilterChips options={['all', ...APPLICATION_STATUSES]} value={filter} onChange={setFilter} counts={applicationsQuery.data ? counts : {}} />

      {applicationsQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading applications...</div>
      ) : applicationsQuery.isError ? (
        <ErrorState message={apiMessage(applicationsQuery.error, 'Could not load the applications.')} onRetry={() => applicationsQuery.refetch()} />
      ) : applications.length === 0 ? (
        <EmptyState icon={MdAssignment}>
          <p>{filter === 'all' ? 'No applications yet.' : `No ${filter} applications.`}</p>
        </EmptyState>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {applications.map((a) => (
            <div key={a.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.97rem' }}>{a.business_name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Applied {format(new Date(a.created_at), 'dd MMM yyyy, HH:mm')}</div>
                </div>
                <StatusPill status={a.status} />
              </div>
              <Detail label="Contact">{a.contact_name}</Detail>
              <Detail label="Email"><a href={`mailto:${a.email}`} style={{ color: '#0E7AC4' }}>{a.email}</a></Detail>
              <Detail label="Phone">{a.phone}</Detail>
              <Detail label="Employees">{String(a.employee_count)}</Detail>
              <Detail label="Tier">
                {a.tier_name ? `${a.tier_name}, ${feeLabel(a.quoted_fee, a.tier_currency || 'USD')} a year` : 'No tier fitted; set the fee by hand'}
              </Detail>
              <Detail label="Category">{a.category}</Detail>
              <Detail label="Address">{a.address}</Detail>
              <Detail label="Website">{a.website}</Detail>
              <Detail label="Location">{a.latitude !== null ? `${a.latitude}, ${a.longitude}` : null}</Detail>
              {a.message && (
                <div style={{ fontSize: '0.8rem', background: 'var(--bg-input)', borderRadius: 8, padding: '0.5rem 0.7rem', whiteSpace: 'pre-wrap' }}>{a.message}</div>
              )}
              {a.admin_notes && (
                <div style={{ fontSize: '0.8rem', color: '#B26A00', whiteSpace: 'pre-wrap' }}>Notes: {a.admin_notes}</div>
              )}
              {a.business_id && <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#2D8C00' }}>Member listing created</div>}

              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {a.status === 'new' && (
                  <button type="button" disabled={updateMutation.isPending} onClick={() => setStatus(a, 'invoiced')} style={smallButton('#F5A623')}>
                    <MdReceipt size={14} /> Mark invoiced
                  </button>
                )}
                {a.status !== 'rejected' && (
                  <button type="button" onClick={() => setActivating(a)} style={smallButton('#2D8C00')}>
                    <MdCheckCircle size={14} /> {a.business_id ? 'Renew' : 'Paid: activate'}
                  </button>
                )}
                {(a.status === 'new' || a.status === 'invoiced') && (
                  <button type="button" disabled={updateMutation.isPending} onClick={() => setStatus(a, 'rejected')} style={smallButton('#CC2229')}>
                    <MdCancel size={14} /> Reject
                  </button>
                )}
                {a.status === 'rejected' && (
                  <button type="button" disabled={updateMutation.isPending} onClick={() => setStatus(a, 'new')} style={smallButton('#0E7AC4')}>
                    <MdUndo size={14} /> Reopen
                  </button>
                )}
                <button type="button" onClick={() => setNoting(a)} style={smallButton('#888888')}>
                  <MdNotes size={14} /> Notes
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {activating && (
        <Modal title={`${activating.business_id ? 'Renew' : 'Activate'} ${activating.business_name}`} onClose={() => setActivating(null)} width="560px">
          <ActivateForm
            key={activating.id}
            application={activating}
            submitting={activateMutation.isPending}
            onSubmit={(data) => activateMutation.mutate({ id: activating.id, data })}
          />
        </Modal>
      )}

      {noting && (
        <Modal title={`Notes: ${noting.business_name}`} onClose={() => setNoting(null)}>
          <NotesForm
            key={noting.id}
            application={noting}
            submitting={updateMutation.isPending}
            onSubmit={(admin_notes) => updateMutation.mutate({ id: noting.id, data: { admin_notes } })}
          />
        </Modal>
      )}
    </Layout>
  );
};

export default AdminApplications;
