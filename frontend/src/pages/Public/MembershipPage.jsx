import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { MdStorefront, MdRecordVoiceOver, MdMap, MdCheckCircle } from 'react-icons/md';
import PublicLayout from './PublicLayout';
import LocationPicker from '../../components/UI/LocationPicker';
import { getPublicMembershipTiers, applyForMembership } from '../../api/members';
import {
  EMPTY_FORM, HONEYPOT_FIELD, FEE_TO_BE_CONFIRMED, INVOICE_BY_EMAIL, formatFee, tierRange, tierForCount, buildApplication,
  thankYou, fieldErrorsFrom, submitErrorMessage,
} from './membershipModel';

const card = { background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 'clamp(1rem, 4vw, 1.75rem)' };

const inputStyle = (hasError) => ({
  background: 'var(--bg-input)', border: `1px solid ${hasError ? 'var(--danger)' : 'var(--border)'}`,
  borderRadius: 'var(--radius)', color: 'var(--text)', padding: '0.65rem 0.9rem', fontSize: '1rem', width: '100%',
});

/** A labelled input or textarea with its error, linked for screen readers. */
const FormField = ({ id, label, required, error, hint, textarea, ...props }) => {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  const Control = textarea ? 'textarea' : 'input';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <label htmlFor={id} style={{ fontSize: '0.88rem', fontWeight: 700, color: '#333' }}>
        {label}{required && <span aria-hidden="true" style={{ color: '#D12229' }}> *</span>}
      </label>
      <Control id={id} name={id} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} aria-required={required || undefined}
        style={{ ...inputStyle(Boolean(error)), ...(textarea ? { resize: 'vertical', fontFamily: 'inherit' } : {}) }} {...props} />
      {hint && <span id={`${id}-hint`} style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{hint}</span>}
      {error && <span id={`${id}-error`} style={{ fontSize: '0.82rem', color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
};

/** A titled group of fields, as the policy groups them. */
const FieldGroup = ({ id, title, children }) => (
  <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
    <legend id={id} style={{ fontSize: '1rem', fontWeight: 800, color: '#111', marginBottom: '0.2rem', padding: 0 }}>{title}</legend>
    {children}
  </fieldset>
);

const twoColumns = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' };

/** Opens beside the form, so what the applicant typed is kept. */
const NewTabLink = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#0E7AC4', fontWeight: 700 }}>{children}</a>
);

const Benefit = ({ icon: Icon, title, children }) => (
  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
    <Icon size={26} color="#D12229" style={{ flexShrink: 0 }} aria-hidden="true" />
    <div>
      <h3 style={{ fontSize: '0.98rem', fontWeight: 800, marginBottom: '0.15rem' }}>{title}</h3>
      <p style={{ fontSize: '0.9rem', color: '#444', lineHeight: 1.5 }}>{children}</p>
    </div>
  </div>
);

const TierList = ({ query }) => {
  if (query.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading the membership fees...</p>;
  if (query.isError) {
    return (
      <div role="alert" style={{ color: '#111' }}>
        <p style={{ marginBottom: '0.6rem' }}>We could not load the membership fees just now. You can still apply below.</p>
        <button type="button" onClick={() => query.refetch()} style={{ padding: '0.4rem 1rem', borderRadius: 8, border: '1px solid var(--primary)', background: 'none', color: 'var(--primary)', fontWeight: 700 }}>
          Try again
        </button>
      </div>
    );
  }
  const tiers = query.data || [];
  if (tiers.length === 0) return <p style={{ color: 'var(--text-muted)' }}>The membership fees are being set. Apply below and we will tell you the fee.</p>;
  const anyProvisional = tiers.some((t) => t.is_provisional);
  return (
    <>
      <ul style={{ listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
        {tiers.map((t) => (
          <li key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem', background: 'var(--bg-input)' }}>
            <div style={{ fontSize: '1rem', color: '#111', fontWeight: 800 }}>{t.name}</div>
            <div style={{ fontSize: '0.85rem', color: '#444', fontWeight: 600 }}>{tierRange(t)}</div>
            <div style={{ fontSize: '1.15rem', fontWeight: 900, color: t.annual_fee === null ? '#555' : '#2D8C00', marginTop: '0.2rem' }}>
              {t.annual_fee === null ? FEE_TO_BE_CONFIRMED : formatFee(t)}
            </div>
            {t.is_provisional && t.annual_fee !== null && <div style={{ fontSize: '0.75rem', color: '#8A5200', marginTop: '0.2rem' }}>Provisional</div>}
          </li>
        ))}
      </ul>
      {anyProvisional && (
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
          Provisional fees may still change. The fee you are quoted when you apply is the one on your invoice.
        </p>
      )}
    </>
  );
};

const ThankYou = ({ data }) => {
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const t = thankYou(data);
  return (
    <section style={card} aria-labelledby="thanks-heading">
      <MdCheckCircle size={40} color="#2D8C00" aria-hidden="true" />
      <h2 id="thanks-heading" ref={headingRef} tabIndex={-1} style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0.5rem 0', outline: 'none' }}>
        Thank you, your application is in
      </h2>
      <p style={{ lineHeight: 1.6, marginBottom: '1rem' }}>
        {t.tierName ? <>Your membership tier is <strong>{t.tierName}</strong>. </> : null}
        Yearly fee: <strong>{t.fee}</strong>{t.provisional && t.fee !== FEE_TO_BE_CONFIRMED ? ' (provisional)' : ''}.
      </p>
      {t.instructions ? (
        <>
          <h3 style={{ fontSize: '1rem', fontWeight: 800, marginBottom: '0.4rem' }}>How to pay</h3>
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1rem' }}>
            {t.instructions}
          </p>
          <p style={{ marginTop: '0.9rem', lineHeight: 1.6 }}>Your business appears on the CaribWayz map once your payment has arrived.</p>
        </>
      ) : (
        <p style={{ lineHeight: 1.6 }}>
          {INVOICE_BY_EMAIL} Your business appears on the CaribWayz map once it is paid.
        </p>
      )}
      <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
        Reference: {data.application_id}
      </p>
    </section>
  );
};

const MembershipPage = () => {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const errorRef = useRef(null);

  useEffect(() => { document.title = 'CaribWayz Business Membership'; }, []);

  const tiersQuery = useQuery({
    queryKey: ['public-membership-tiers'],
    queryFn: getPublicMembershipTiers,
    select: (res) => res.data.data.tiers,
  });

  const mutation = useMutation({
    mutationFn: applyForMembership,
    onError: (err) => {
      setErrors(fieldErrorsFrom(err) || {});
      setFormError(submitErrorMessage(err));
    },
  });

  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleSubmit = (e) => {
    e.preventDefault();
    const result = buildApplication(form);
    if (result.errors) {
      setErrors(result.errors);
      setFormError('Some details need fixing. Check the fields marked below.');
      return;
    }
    setErrors({});
    setFormError(null);
    mutation.mutate(result.body);
  };

  const hintTier = tierForCount(tiersQuery.data, form.employee_count.trim());

  return (
    <PublicLayout>
      <section style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 'clamp(1.5rem, 5vw, 2.2rem)', fontWeight: 900, lineHeight: 1.2, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <MdStorefront color="#F5A623" aria-hidden="true" /> Put your business on the CaribWayz map
        </h1>
        <p style={{ fontSize: '1.02rem', color: '#333', marginTop: '0.6rem', lineHeight: 1.6, maxWidth: 720 }}>
          CaribWayz member businesses are shown to drivers on the map, and drivers who pass close by hear your name and any
          promotion you are running, with a one-tap option to add you to their route. Membership is a yearly fee based on
          how many people you employ.
        </p>
      </section>

      <section style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.1rem', marginBottom: '1.5rem' }} aria-label="What members get">
        <Benefit icon={MdMap} title="On the map">Your business is marked on the CaribWayz map, with your address, phone, website and directions.</Benefit>
        <Benefit icon={MdRecordVoiceOver} title="Announced nearby">Drivers close to you hear &ldquo;You are in close proximity to&rdquo; your business, plus your current promotion.</Benefit>
        <Benefit icon={MdStorefront} title="Add to route">Drivers can add your business as a stop on their trip with one tap.</Benefit>
      </section>

      {mutation.isSuccess ? (
        <ThankYou data={mutation.data.data.data} />
      ) : (
        <>
          <section style={{ ...card, marginBottom: '1.5rem' }} aria-labelledby="fees-heading">
            <h2 id="fees-heading" style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: '0.9rem' }}>Yearly membership fees</h2>
            <TierList query={tiersQuery} />
          </section>

          <section style={card} aria-labelledby="apply-heading">
            <h2 id="apply-heading" style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: '0.3rem' }}>Apply for membership</h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Fields marked <span style={{ color: '#D12229' }}>*</span> are required. We use these details only to handle your membership, as our <NewTabLink href="/privacy">Privacy Policy</NewTabLink> explains.
            </p>

            {formError && (
              <div ref={errorRef} tabIndex={-1} role="alert" style={{ border: '1px solid var(--danger)', background: '#fdecec', color: '#111', borderRadius: 'var(--radius)', padding: '0.75rem 1rem', marginBottom: '1rem', outline: 'none' }}>
                {formError}
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <FieldGroup id="business-group" title="Your business">
                <div style={twoColumns}>
                  <FormField id="business_name" label="Registered business name" required autoComplete="organization" maxLength={200}
                    value={form.business_name} onChange={set('business_name')} error={errors.business_name} />
                  <FormField id="trading_name" label="Trading name, if different" maxLength={200}
                    hint="The name drivers see in the app." value={form.trading_name} onChange={set('trading_name')} error={errors.trading_name} />
                  <FormField id="category" label="Type of business" required placeholder="e.g. restaurant, gas station, hotel" maxLength={100}
                    value={form.category} onChange={set('category')} error={errors.category} />
                  <FormField id="phone" label="Business telephone" required type="tel" autoComplete="tel" maxLength={40}
                    value={form.phone} onChange={set('phone')} error={errors.phone} />
                  <FormField id="business_email" label="Business email" type="email" maxLength={255}
                    value={form.business_email} onChange={set('business_email')} error={errors.business_email} />
                  <FormField id="website" label="Website or social media page" type="url" autoComplete="url" placeholder="https://" maxLength={500}
                    value={form.website} onChange={set('website')} error={errors.website} />
                </div>
                <FormField id="description" label="About the business" textarea rows={3} maxLength={1000}
                  hint="A sentence or two for your business profile." value={form.description} onChange={set('description')} error={errors.description} />
                <FormField id="address" label="Physical business address" required autoComplete="street-address" maxLength={500}
                  value={form.address} onChange={set('address')} error={errors.address} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <span id="pin-label" style={{ fontSize: '0.88rem', fontWeight: 700, color: '#333' }}>Where is it on the map?</span>
                  <LocationPicker
                    latitude={form.latitude}
                    longitude={form.longitude}
                    onPick={(latitude, longitude) => setForm({ ...form, latitude: String(latitude), longitude: String(longitude) })}
                    hint="Tap the map where your entrance is. Zoom in for accuracy. If you skip this, we place you from your address."
                  />
                  {form.latitude !== '' && (
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.85rem', color: '#333' }}>
                      <span>Pin placed at {form.latitude}, {form.longitude}</span>
                      <button type="button" onClick={() => setForm({ ...form, latitude: '', longitude: '' })}
                        style={{ background: 'none', border: 'none', color: '#0E7AC4', fontWeight: 700, padding: '0.4rem 0', minHeight: 44, cursor: 'pointer' }}>
                        Clear pin
                      </button>
                    </div>
                  )}
                  {errors.latitude && <span role="alert" style={{ fontSize: '0.82rem', color: 'var(--danger)' }}>{errors.latitude}</span>}
                </div>
              </FieldGroup>

              <FieldGroup id="representative-group" title="Owner or authorized representative">
                <div style={twoColumns}>
                  <FormField id="contact_name" label="Full name" required autoComplete="name" maxLength={200}
                    value={form.contact_name} onChange={set('contact_name')} error={errors.contact_name} />
                  <FormField id="contact_position" label="Position or relationship to the business" required placeholder="e.g. Owner, Manager" maxLength={100}
                    autoComplete="organization-title" value={form.contact_position} onChange={set('contact_position')} error={errors.contact_position} />
                  <FormField id="contact_phone" label="Contact number" required type="tel" maxLength={40}
                    value={form.contact_phone} onChange={set('contact_phone')} error={errors.contact_phone} />
                  <FormField id="email" label="Email" required type="email" autoComplete="email" maxLength={255}
                    value={form.email} onChange={set('email')} error={errors.email} />
                </div>
              </FieldGroup>

              <FieldGroup id="membership-group" title="Membership">
                <div style={twoColumns}>
                  <FormField id="employee_count" label="Number of employees" required inputMode="numeric" maxLength={7}
                    value={form.employee_count} onChange={set('employee_count')} error={errors.employee_count}
                    hint={hintTier ? `Your tier: ${hintTier.name} (${tierRange(hintTier)}), ${hintTier.annual_fee === null ? FEE_TO_BE_CONFIRMED : formatFee(hintTier)}` : 'Your tier is chosen from this number.'} />
                </div>
                <FormField id="message" label="Anything else we should know" textarea rows={3} maxLength={2000}
                  value={form.message} onChange={set('message')} error={errors.message} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <label htmlFor="accept_terms" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', fontSize: '0.92rem', lineHeight: 1.5, color: '#111', cursor: 'pointer' }}>
                    <input id="accept_terms" name="accept_terms" type="checkbox" checked={form.accept_terms === true}
                      onChange={(e) => setForm({ ...form, accept_terms: e.target.checked })}
                      aria-invalid={errors.accept_terms ? 'true' : undefined}
                      aria-describedby={errors.accept_terms ? 'accept_terms-error' : undefined}
                      aria-required="true"
                      style={{ width: 22, height: 22, marginTop: 1, flexShrink: 0, accentColor: '#D12229' }} />
                    <span>
                      I have read and accept the <NewTabLink href="/membership/policy">Business Membership Policy</NewTabLink> and
                      the <NewTabLink href="/terms">Terms and Conditions</NewTabLink>, I am authorized to register this business, and
                      the details above are accurate.<span aria-hidden="true" style={{ color: '#D12229' }}> *</span>
                    </span>
                  </label>
                  {errors.accept_terms && <span id="accept_terms-error" style={{ fontSize: '0.82rem', color: 'var(--danger)' }}>{errors.accept_terms}</span>}
                </div>
              </FieldGroup>

              {/* Hidden from people and from screen readers; only a bot fills it. */}
              <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
                <label htmlFor={HONEYPOT_FIELD}>Leave this empty</label>
                <input id={HONEYPOT_FIELD} name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off"
                  value={form[HONEYPOT_FIELD] || ''} onChange={set(HONEYPOT_FIELD)} />
              </div>
              <div>
                <button type="submit" disabled={mutation.isPending} style={{
                  background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius)',
                  padding: '0.8rem 2rem', fontSize: '1rem', fontWeight: 700, minHeight: 44,
                  cursor: mutation.isPending ? 'not-allowed' : 'pointer', opacity: mutation.isPending ? 0.7 : 1,
                }}>
                  {mutation.isPending ? 'Sending...' : 'Send application'}
                </button>
              </div>
            </form>
          </section>
        </>
      )}
    </PublicLayout>
  );
};

export default MembershipPage;
