import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitReport } from '../../api/reports';
import Input from '../../components/UI/Input';
import Button from '../../components/UI/Button';
import toast from 'react-hot-toast';

const TYPES = ['traffic', 'accident', 'police', 'construction', 'hazard', 'flood', 'pothole', 'other'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

const ReportCreate = ({ currentPosition, onSuccess }) => {
  const [form, setForm] = useState({
    type: 'traffic', latitude: currentPosition?.[0] || '', longitude: currentPosition?.[1] || '',
    severity: 'medium', description: '',
  });

  const mutation = useMutation({
    mutationFn: submitReport,
    onSuccess: () => { toast.success('Report submitted!'); onSuccess?.(); },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to submit'),
  });

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by this browser');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => setForm((f) => ({ ...f, latitude: coords.latitude.toFixed(6), longitude: coords.longitude.toFixed(6) })),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) toast.error('Location permission denied — please allow access in browser settings');
        else if (err.code === err.TIMEOUT) toast.error('Location request timed out — please try again');
        else toast.error('Location unavailable');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.latitude || !form.longitude) return toast.error('Location is required');
    mutation.mutate(form);
  };

  const selectStyle = { background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', padding: '0.6rem 0.9rem', fontSize: '0.95rem', width: '100%' };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div>
        <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>Incident Type</label>
        <select name="type" value={form.type} onChange={handleChange} style={selectStyle}>
          {TYPES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
        </select>
      </div>

      <div>
        <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>Severity</label>
        <select name="severity" value={form.severity} onChange={handleChange} style={selectStyle}>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <div style={{ flex: 1 }}><Input label="Latitude" name="latitude" placeholder="10.6918" value={form.latitude} onChange={handleChange} /></div>
        <div style={{ flex: 1 }}><Input label="Longitude" name="longitude" placeholder="-61.2225" value={form.longitude} onChange={handleChange} /></div>
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={useMyLocation}>Use My Current Location</Button>

      <div>
        <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>Description (optional)</label>
        <textarea
          name="description" value={form.description} onChange={handleChange}
          placeholder="Describe the incident..."
          rows={3}
          style={{ ...selectStyle, resize: 'vertical' }}
        />
      </div>

      <Button type="submit" fullWidth loading={mutation.isPending}>Submit Report</Button>
    </form>
  );
};

export default ReportCreate;
