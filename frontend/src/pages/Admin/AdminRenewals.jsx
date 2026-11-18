import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMembershipRenewals, sendRenewalReminder } from '../../api/members';
import Layout from '../../components/Layout/Layout';
import { MdEmail, MdEventRepeat, MdWarning } from 'react-icons/md';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { apiMessage } from './memberAdminModel';
import { daysLeftLabel, reminderAction } from './memberAddonsModel';
import { StatusPill, PageHeader, EmptyState, ErrorState, smallButton } from './memberUi';

const when = (iso) => (iso ? format(new Date(iso), 'dd MMM yyyy, HH:mm') : null);

const RenewalRow = ({ entry, emailConfigured, sending, onSend }) => {
  const action = reminderAction(entry, emailConfigured);
  const reasonId = `reminder-reason-${entry.id}`;
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1rem 1.2rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 220, flex: '1 1 260px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700 }}>{entry.name}</span>
          <StatusPill status={entry.membership_status} />
        </div>
        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: entry.expired ? '#CC2229' : '#B26A00' }}>
          {daysLeftLabel(entry.days_left, entry.expired)} ({when(entry.membership_expires_at)})
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {entry.tier_name || 'No tier'}{entry.contact_name ? ` · ${entry.contact_name}` : ''}
        </div>
        <div style={{ fontSize: '0.8rem', color: entry.recipient_email ? 'var(--text-muted)' : '#CC2229' }}>
          {entry.recipient_email ? `Email: ${entry.recipient_email}` : 'No email on file'}
        </div>
        <div style={{ fontSize: '0.8rem', color: entry.reminded_today ? '#2D8C00' : 'var(--text-muted)', fontWeight: entry.reminded_today ? 700 : 400 }}>
          {entry.last_reminder_sent_at
            ? `${entry.reminded_today ? 'Sent today' : 'Last reminder'}: ${when(entry.last_reminder_sent_at)}${entry.last_reminder_sent_by_name ? ` by ${entry.last_reminder_sent_by_name}` : ''}`
            : 'No reminder sent yet'}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.3rem' }}>
        <button
          type="button"
          disabled={action.disabled || sending}
          aria-describedby={action.reason ? reasonId : undefined}
          onClick={() => {
            if (action.confirm && !window.confirm(action.confirm)) return;
            onSend(entry, Boolean(action.confirm));
          }}
          style={{ ...smallButton(action.disabled ? '#888888' : '#0E7AC4'), cursor: action.disabled || sending ? 'not-allowed' : 'pointer', padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}
        >
          <MdEmail size={16} /> {sending ? 'Sending...' : action.label}
        </button>
        {action.reason && <span id={reasonId} style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: 240, textAlign: 'right' }}>{action.reason}</span>}
      </div>
    </div>
  );
};

const Section = ({ title, entries, empty, emailConfigured, sendingId, onSend }) => (
  <section style={{ marginBottom: '2rem' }} aria-label={title}>
    <h3 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: '0.75rem' }}>{title} ({entries.length})</h3>
    {entries.length === 0 ? (
      <EmptyState icon={MdEventRepeat}><p>{empty}</p></EmptyState>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {entries.map((e) => (
          <RenewalRow key={e.id} entry={e} emailConfigured={emailConfigured} sending={sendingId === e.id} onSend={onSend} />
        ))}
      </div>
    )}
  </section>
);

const AdminRenewals = () => {
  const queryClient = useQueryClient();

  const renewalsQuery = useQuery({
    queryKey: ['admin-membership-renewals'],
    queryFn: getMembershipRenewals,
    select: (res) => res.data.data,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-membership-renewals'] });

  const sendMutation = useMutation({
    mutationFn: ({ id, resend }) => sendRenewalReminder(id, { resend }),
    onSuccess: (res) => { refresh(); toast.success(res?.data?.message || 'Reminder sent'); },
    // A 409 means another admin (or another tab) sent one today: the list
    // is reloaded so the row says so, and the button then asks to confirm.
    onError: (err) => { refresh(); toast.error(apiMessage(err, 'Failed to send the reminder')); },
  });

  const data = renewalsQuery.data;
  const windowDays = data?.window_days ?? 30;

  return (
    <Layout>
      <PageHeader
        icon={MdEventRepeat}
        title="Renewal Reminders"
        subtitle={`Memberships ending in the next ${windowDays} days, and those that ended in the last ${windowDays}. Send reminder emails the business once; nothing is ever sent automatically.`}
      />

      {renewalsQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading memberships...</div>
      ) : renewalsQuery.isError ? (
        <ErrorState message={apiMessage(renewalsQuery.error, 'Could not load the renewal reminders list.')} onRetry={() => renewalsQuery.refetch()} />
      ) : (
        <>
          {!data.email_configured && (
            <div role="alert" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', padding: '0.9rem 1.1rem', marginBottom: '1.5rem', borderRadius: 'var(--radius)', border: '1px solid #B26A00', background: '#B26A0018', fontSize: '0.88rem' }}>
              <MdWarning size={20} color="#B26A00" style={{ flexShrink: 0 }} />
              <span>Email (SMTP) is not set up on the server, so reminders cannot be sent. The list still shows who to contact.</span>
            </div>
          )}
          <Section
            title={`Ending in the next ${windowDays} days`}
            entries={data.ending_soon}
            empty={`No memberships end in the next ${windowDays} days.`}
            emailConfigured={data.email_configured}
            sendingId={sendMutation.isPending ? sendMutation.variables?.id : null}
            onSend={(entry, resend) => sendMutation.mutate({ id: entry.id, resend })}
          />
          <Section
            title={`Ended in the last ${windowDays} days`}
            entries={data.recently_expired}
            empty={`No memberships ended in the last ${windowDays} days.`}
            emailConfigured={data.email_configured}
            sendingId={sendMutation.isPending ? sendMutation.variables?.id : null}
            onSend={(entry, resend) => sendMutation.mutate({ id: entry.id, resend })}
          />
        </>
      )}
    </Layout>
  );
};

export default AdminRenewals;
