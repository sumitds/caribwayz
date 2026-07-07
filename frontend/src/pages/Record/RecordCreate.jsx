import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRecord } from '../../api/records';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import { MdArrowBack, MdArrowForward, MdCheck, MdDescription } from 'react-icons/md';
import toast from 'react-hot-toast';

const PARISHES = [
  'Kingston','St. Andrew','St. Thomas','Portland','St. Mary',
  'St. Ann','Trelawny','St. James','Hanover','Westmoreland',
  'St. Elizabeth','Manchester','Clarendon','St. Catherine',
];

const TYPES = [
  { value: 'accident', label: 'Road Accident' },
  { value: 'collision', label: 'Vehicle Collision' },
  { value: 'hit_and_run', label: 'Hit & Run' },
  { value: 'vehicle_damage', label: 'Vehicle Damage' },
  { value: 'theft', label: 'Vehicle Theft' },
  { value: 'other', label: 'Other Incident' },
];

const SEVERITIES = [
  { value: 'minor', label: 'Minor', desc: 'No injuries, minor damage', color: '#2D8C00' },
  { value: 'major', label: 'Major', desc: 'Injuries or significant damage', color: '#F5A623' },
  { value: 'fatal', label: 'Fatal', desc: 'Fatality or critical injuries', color: '#CC2229' },
];

const selectStyle = {
  background: 'var(--bg-input)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text)',
  padding: '0.65rem 0.9rem', fontSize: '0.93rem', width: '100%',
};

const Label = ({ children }) => (
  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
    {children}
  </label>
);

const RecordCreate = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    type: 'accident',
    severity: 'minor',
    parish: '',
    occurred_date: '',
    occurred_time: '',
    location_text: '',
    description: '',
    cause: '',
    police_report_number: '',
    other_party_name: '',
    other_party_contact: '',
    other_party_vehicle: '',
    witness_info: '',
  });

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const mutation = useMutation({
    mutationFn: (data) => createRecord(data),
    onSuccess: (res) => {
      queryClient.invalidateQueries(['my-records']);
      toast.success('Incident record created');
      navigate(`/record/${res.data.data.record.id}`);
    },
    onError: () => toast.error('Failed to save record'),
  });

  const handleSubmit = () => {
    if (!form.description) return toast.error('Please describe what happened');
    const occurred_at = form.occurred_date
      ? `${form.occurred_date}T${form.occurred_time || '00:00'}:00`
      : null;
    mutation.mutate({ ...form, occurred_at });
  };

  const now = new Date();
  const loggedAt = now.toLocaleString('en-JM', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Layout>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.75rem' }}>
          <button onClick={() => navigate('/record')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.25rem' }}>
            <MdArrowBack size={22} />
          </button>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 800 }}>Log Incident</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>For police report & insurance documentation</p>
          </div>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.75rem' }}>
          {[1, 2].map((s) => (
            <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: s <= step ? '#CC2229' : 'var(--border)', transition: 'background 0.2s' }} />
          ))}
        </div>

        {/* Auto-logged timestamp */}
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.85rem 1.1rem', marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', fontWeight: 600 }}>Event Logged</span>
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#F5A623' }}>{loggedAt}</span>
        </div>

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
            {/* Severity */}
            <div>
              <Label>Severity *</Label>
              <div style={{ display: 'flex', gap: '0.6rem' }}>
                {SEVERITIES.map(({ value, label, desc, color }) => (
                  <button
                    key={value}
                    onClick={() => setForm((f) => ({ ...f, severity: value }))}
                    style={{
                      flex: 1, padding: '0.75rem 0.5rem', borderRadius: 'var(--radius)',
                      border: `2px solid ${form.severity === value ? color : 'var(--border)'}`,
                      background: form.severity === value ? `${color}18` : 'var(--bg-card)',
                      cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s',
                    }}
                  >
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.2rem', lineHeight: 1.3 }}>{desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Incident type */}
            <div>
              <Label>Incident Type *</Label>
              <select value={form.type} onChange={set('type')} style={selectStyle}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            {/* Parish */}
            <div>
              <Label>Parish where it occurred</Label>
              <select value={form.parish} onChange={set('parish')} style={selectStyle}>
                <option value="">Select parish...</option>
                {PARISHES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            {/* Date / Time */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <Label>Date of Incident</Label>
                <input type="date" value={form.occurred_date} onChange={set('occurred_date')} style={selectStyle} />
              </div>
              <div>
                <Label>Time of Incident</Label>
                <input type="time" value={form.occurred_time} onChange={set('occurred_time')} style={selectStyle} />
              </div>
            </div>

            <Button fullWidth onClick={() => setStep(2)}>
              Next <MdArrowForward size={16} />
            </Button>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            <Input label="Location / Street *" placeholder="e.g. Half Way Tree Rd, Kingston" value={form.location_text} onChange={set('location_text')} />

            <div>
              <Label>What happened? *</Label>
              <textarea
                value={form.description}
                onChange={set('description')}
                placeholder="Describe the incident in detail..."
                rows={4}
                style={{ ...selectStyle, resize: 'vertical', lineHeight: 1.5 }}
              />
            </div>

            <Input label="Cause of Incident" placeholder="e.g. Driver ran red light, road was wet" value={form.cause} onChange={set('cause')} />

            <Input label="Police Report Number" placeholder="e.g. KGN/2025/001234 (if available)" value={form.police_report_number} onChange={set('police_report_number')} />

            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
              <p style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.85rem' }}>
                Other Party (Optional)
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <Input label="Other Party Name" placeholder="Driver name" value={form.other_party_name} onChange={set('other_party_name')} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  <Input label="Contact" placeholder="Phone number" value={form.other_party_contact} onChange={set('other_party_contact')} />
                  <Input label="Vehicle Plate" placeholder="e.g. AB 1234" value={form.other_party_vehicle} onChange={set('other_party_vehicle')} />
                </div>
              </div>
            </div>

            <div>
              <Label>Witness Information</Label>
              <textarea
                value={form.witness_info}
                onChange={set('witness_info')}
                placeholder="Names and contact details of any witnesses..."
                rows={2}
                style={{ ...selectStyle, resize: 'vertical' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.25rem' }}>
              <Button variant="secondary" onClick={() => setStep(1)}>
                <MdArrowBack size={16} /> Back
              </Button>
              <Button onClick={handleSubmit} loading={mutation.isPending}>
                <MdCheck size={16} /> Submit Record
              </Button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
};

export default RecordCreate;
