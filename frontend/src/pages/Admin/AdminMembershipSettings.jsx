import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMembershipSettings, updateMembershipSettings } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import { MdSettings } from 'react-icons/md';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { apiMessage } from './memberAdminModel';
import { Field, PageHeader, ErrorState, textareaStyle } from './memberUi';

const AdminMembershipSettings = () => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(null);
  const [emailError, setEmailError] = useState(null);

  const settingsQuery = useQuery({
    queryKey: ['admin-membership-settings'],
    queryFn: getMembershipSettings,
    select: (res) => res.data.data.settings,
  });

  // The form starts from what is saved, once it has loaded.
  useEffect(() => {
    if (settingsQuery.data && form === null) {
      setForm({
        payment_instructions: settingsQuery.data.payment_instructions || '',
        contact_email: settingsQuery.data.contact_email || '',
      });
    }
  }, [settingsQuery.data, form]);

  const mutation = useMutation({
    mutationFn: updateMembershipSettings,
    onSuccess: (res) => {
      queryClient.setQueryData(['admin-membership-settings'], res);
      toast.success('Membership settings saved');
    },
    onError: (err) => toast.error(apiMessage(err, 'Failed to save the settings')),
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    const email = form.contact_email.trim();
    if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Enter an email address, or leave it empty');
      return;
    }
    setEmailError(null);
    mutation.mutate({ payment_instructions: form.payment_instructions, contact_email: email === '' ? null : email });
  };

  return (
    <Layout>
      <PageHeader
        icon={MdSettings}
        title="Membership Settings"
        subtitle="What the public membership page tells a business after it applies, and where the team is told about new applications."
      />

      {settingsQuery.isLoading || (settingsQuery.data && form === null) ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading settings...</div>
      ) : settingsQuery.isError ? (
        <ErrorState message={apiMessage(settingsQuery.error, 'Could not load the settings.')} onRetry={() => settingsQuery.refetch()} />
      ) : (
        <form onSubmit={handleSubmit} noValidate style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.1rem', maxWidth: 720 }}>
          <Field label="Payment instructions" htmlFor="payment-instructions">
            <textarea
              id="payment-instructions"
              rows={8}
              maxLength={5000}
              value={form.payment_instructions}
              onChange={(e) => setForm({ ...form, payment_instructions: e.target.value })}
              placeholder={'e.g.\nBank: ...\nAccount name: ...\nAccount number: ...\nReference: your business name'}
              style={textareaStyle}
            />
          </Field>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '-0.6rem' }}>
            Shown on the thank-you screen after a business applies. While this is empty the page says
            &ldquo;We&rsquo;ll email you an invoice.&rdquo; instead.
          </p>
          <Input
            label="Contact email for new applications"
            type="email"
            value={form.contact_email}
            onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
            error={emailError}
            placeholder="team@caribwayz.com"
          />
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '-0.6rem' }}>
            Each new application is emailed here when the server can send email. Empty uses the main admin address.
          </p>
          {settingsQuery.data?.updated_at && (
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Last saved {format(new Date(settingsQuery.data.updated_at), 'dd MMM yyyy, HH:mm')}
            </p>
          )}
          <div>
            <Button type="submit" loading={mutation.isPending}>Save Settings</Button>
          </div>
        </form>
      )}
    </Layout>
  );
};

export default AdminMembershipSettings;
