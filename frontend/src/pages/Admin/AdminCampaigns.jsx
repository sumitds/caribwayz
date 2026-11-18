import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getBusinesses } from '../../api/admin';
import {
  getMemberCampaigns, addMemberCampaign, updateMemberCampaign, endMemberCampaign, deleteMemberCampaign,
} from '../../api/members';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Modal from '../../components/UI/Modal';
import { MdAdd, MdCampaign, MdDelete, MdEdit, MdStop } from 'react-icons/md';
import toast from 'react-hot-toast';
import { apiMessage } from './memberAdminModel';
import {
  CAMPAIGN_KINDS, CAMPAIGN_STATES, CAMPAIGN_DURATIONS, CAMPAIGN_STATE_LABELS, OFFER_MAX, jamaicaToday, formatDay,
  emptyCampaignForm, campaignFormFrom, campaignEndDate, campaignPayload, canEndCampaign, campaignUseNote,
} from './memberAddonsModel';
import {
  StatusPill, Field, FilterChips, PageHeader, EmptyState, ErrorState, selectStyle, textareaStyle, smallButton,
} from './memberUi';

const DURATION_LABELS = { 7: '7 days', 14: '14 days', 30: '30 days', custom: 'Custom dates (seasonal)' };

const CampaignForm = ({ initial, businesses, editing, today, submitting, onSubmit, submitLabel }) => {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const end = campaignEndDate(form);

  const handleSubmit = (e) => {
    e.preventDefault();
    const result = campaignPayload(form, { today, editing });
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmit(result.body);
  };

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      {editing ? (
        <div style={{ fontSize: '0.9rem' }}><strong>Business:</strong> {initial.business_name}</div>
      ) : (
        <Field label="Business *" htmlFor="campaign-business" error={errors.business_id}>
          <select id="campaign-business" value={form.business_id} onChange={set('business_id')} style={selectStyle}>
            <option value="">Choose a business</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>{b.name}{b.membership_status !== 'active' ? ` (${b.membership_status})` : ''}</option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Kind *" htmlFor="campaign-kind" error={errors.kind}>
        <select id="campaign-kind" value={form.kind} onChange={set('kind')} style={{ ...selectStyle, textTransform: 'capitalize' }}>
          {CAMPAIGN_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </Field>
      <Field label={`Offer drivers hear and see (at most ${OFFER_MAX} characters) *`} htmlFor="campaign-offer" error={errors.offer_text}>
        <textarea id="campaign-offer" rows={3} value={form.offer_text} onChange={set('offer_text')} maxLength={OFFER_MAX}
          style={textareaStyle} placeholder="e.g. 10% off lunch for CaribWayz drivers" aria-describedby="campaign-offer-count" />
        <span id="campaign-offer-count" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {form.offer_text.trim().length} / {OFFER_MAX}
        </span>
      </Field>
      <Input label="Start date (Jamaica) *" type="date" value={form.start_date} onChange={set('start_date')} error={errors.start_date} />
      <Field label="Length" htmlFor="campaign-duration">
        <select id="campaign-duration" value={form.duration} onChange={set('duration')} style={selectStyle}>
          {CAMPAIGN_DURATIONS.map((d) => <option key={d} value={d}>{DURATION_LABELS[d]}</option>)}
        </select>
      </Field>
      {form.duration === 'custom' ? (
        <Input label="End date (Jamaica), last day it runs *" type="date" value={form.end_date} onChange={set('end_date')} error={errors.end_date} />
      ) : (
        <div style={{ fontSize: '0.85rem', color: errors.end_date ? 'var(--danger)' : 'var(--text-muted)' }} role={errors.end_date ? 'alert' : undefined}>
          {end ? `Runs ${formatDay(form.start_date)} to ${formatDay(end)}, both days included.` : 'Choose a start date.'}
          {errors.end_date ? ` ${errors.end_date}.` : ''}
        </div>
      )}
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        While it runs, the app speaks this offer instead of the business's own promotion. If two campaigns run at once
        for one business, the one that started later is used.
      </p>
      <Button type="submit" fullWidth loading={submitting}>{submitLabel}</Button>
    </form>
  );
};

const AdminCampaigns = () => {
  const [stateFilter, setStateFilter] = useState('all');
  const [editing, setEditing] = useState(null); // null, 'new', or the campaign being edited
  const queryClient = useQueryClient();
  const today = jamaicaToday();

  const campaignsQuery = useQuery({
    queryKey: ['admin-member-campaigns'],
    queryFn: () => getMemberCampaigns(),
    select: (res) => res.data.data.campaigns,
  });

  const businessesQuery = useQuery({
    queryKey: ['admin-businesses', 'all'],
    queryFn: () => getBusinesses({}),
    select: (res) => res.data.data.businesses,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-member-campaigns'] });

  const addMutation = useMutation({
    mutationFn: addMemberCampaign,
    onSuccess: () => { refresh(); toast.success('Campaign added'); setEditing(null); },
    onError: (err) => toast.error(apiMessage(err, 'Failed to add the campaign')),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateMemberCampaign(id, data),
    onSuccess: () => { refresh(); toast.success('Campaign updated'); setEditing(null); },
    onError: (err) => toast.error(apiMessage(err, 'Failed to update the campaign')),
  });
  const endMutation = useMutation({
    mutationFn: endMemberCampaign,
    onSuccess: () => { refresh(); toast.success('Campaign ended'); },
    onError: (err) => { refresh(); toast.error(apiMessage(err, 'Failed to end the campaign')); },
  });
  const deleteMutation = useMutation({
    mutationFn: deleteMemberCampaign,
    onSuccess: () => { refresh(); toast.success('Campaign deleted'); },
    onError: (err) => { refresh(); toast.error(apiMessage(err, 'Failed to delete the campaign')); },
  });

  const all = campaignsQuery.data || [];
  const counts = { all: all.length };
  CAMPAIGN_STATES.forEach((s) => { counts[s] = all.filter((c) => c.state === s).length; });
  const campaigns = stateFilter === 'all' ? all : all.filter((c) => c.state === stateFilter);
  const businesses = businessesQuery.data || [];
  const busy = endMutation.isPending || deleteMutation.isPending;

  return (
    <Layout>
      <PageHeader
        icon={MdCampaign}
        title="Campaigns"
        subtitle="Promotional and seasonal offers a business has paid for. The app speaks the offer to drivers nearby from the start date to the end date (Jamaica days, both included), then goes back to the business's own promotion."
        action={<Button onClick={() => setEditing('new')}><MdAdd size={18} /> Add Campaign</Button>}
      />

      <FilterChips options={['all', ...CAMPAIGN_STATES]} value={stateFilter} onChange={setStateFilter} counts={counts} />

      {campaignsQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading campaigns...</div>
      ) : campaignsQuery.isError ? (
        <ErrorState message={apiMessage(campaignsQuery.error, 'Could not load the campaigns.')} onRetry={() => campaignsQuery.refetch()} />
      ) : campaigns.length === 0 ? (
        <EmptyState icon={MdCampaign}>
          <p>{stateFilter === 'all' ? 'No campaigns yet. Add one when a business sends its offer.' : `No ${CAMPAIGN_STATE_LABELS[stateFilter].toLowerCase()} campaigns.`}</p>
        </EmptyState>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '1rem' }}>
          {campaigns.map((c) => {
            const useNote = campaignUseNote(c);
            return (
              <div key={c.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.97rem' }}>{c.business_name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'capitalize', marginTop: '0.1rem' }}>{c.kind} campaign</div>
                  </div>
                  <StatusPill status={c.state} />
                </div>
                <div style={{ fontSize: '0.9rem' }}>{c.offer_text}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {formatDay(c.start_date)} to {formatDay(c.end_date)}
                  {c.state === 'ended' ? ' (ended early)' : ''}
                </div>
                {useNote && (
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, color: c.in_use ? '#2D8C00' : '#B26A00' }}>{useNote}</div>
                )}
                {c.created_by_name && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Entered by {c.created_by_name}</div>}
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                  <button type="button" onClick={() => setEditing(c)} style={smallButton('#0E7AC4')}>
                    <MdEdit size={14} /> Edit
                  </button>
                  {canEndCampaign(c) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`End this campaign for ${c.business_name} now? Drivers stop hearing it straight away.`)) endMutation.mutate(c.id);
                      }}
                      style={smallButton('#B26A00')}
                    >
                      <MdStop size={14} /> End now
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete this campaign for ${c.business_name}? This cannot be undone.`)) deleteMutation.mutate(c.id);
                    }}
                    style={smallButton('#CC2229')}
                  >
                    <MdDelete size={14} /> Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'Add Campaign' : 'Edit Campaign'} onClose={() => setEditing(null)} width="560px">
          <CampaignForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? emptyCampaignForm(today) : { ...campaignFormFrom(editing), business_name: editing.business_name }}
            businesses={businesses}
            editing={editing !== 'new'}
            today={today}
            submitting={addMutation.isPending || updateMutation.isPending}
            submitLabel={editing === 'new' ? 'Add Campaign' : 'Save Changes'}
            onSubmit={(body) => (editing === 'new'
              ? addMutation.mutate(body)
              : updateMutation.mutate({ id: editing.id, data: body }))}
          />
        </Modal>
      )}
    </Layout>
  );
};

export default AdminCampaigns;
