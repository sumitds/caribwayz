import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { triggerEmergency, resolveEmergency } from '../../api/emergency';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Badge from '../../components/UI/Badge';
import { MdSos, MdLocalFireDepartment, MdMedicalServices, MdCarCrash, MdBuildCircle } from 'react-icons/md';
import toast from 'react-hot-toast';

const EMERGENCY_TYPES = [
  { value: 'fire', label: 'Fire', icon: MdLocalFireDepartment, color: '#ef4444' },
  { value: 'medical', label: 'Medical', icon: MdMedicalServices, color: '#22c55e' },
  { value: 'accident', label: 'Accident', icon: MdCarCrash, color: '#f97316' },
  { value: 'breakdown', label: 'Breakdown', icon: MdBuildCircle, color: '#f59e0b' },
  { value: 'crime', label: 'Crime', icon: MdSos, color: '#a855f7' },
  { value: 'other', label: 'Other', icon: MdSos, color: '#94a3b8' },
];

const EmergencyPage = () => {
  const [selectedType, setSelectedType] = useState('');
  const [description, setDescription] = useState('');
  const [position, setPosition] = useState({ latitude: '', longitude: '' });
  const [activeAlert, setActiveAlert] = useState(null);

  const triggerMutation = useMutation({
    mutationFn: triggerEmergency,
    onSuccess: (res) => {
      setActiveAlert(res.data.data.alert);
      toast.success('Emergency alert triggered! Help is on the way.', { duration: 6000 });
    },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to trigger emergency'),
  });

  const resolveMutation = useMutation({
    mutationFn: resolveEmergency,
    onSuccess: () => { setActiveAlert(null); toast.success('Emergency resolved'); },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to resolve'),
  });

  const getLocation = () => {
    navigator.geolocation?.getCurrentPosition(
      ({ coords }) => setPosition({ latitude: coords.latitude.toFixed(6), longitude: coords.longitude.toFixed(6) }),
      () => toast.error('Location unavailable')
    );
  };

  const handleSOS = () => {
    if (!selectedType) return toast.error('Select emergency type');
    if (!position.latitude || !position.longitude) return toast.error('Location is required — click "Get My Location"');
    triggerMutation.mutate({ type: selectedType, ...position, description });
  };

  return (
    <Layout>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <MdSos size={56} color="var(--danger)" />
          <h2 style={{ fontSize: '1.6rem', fontWeight: 800, marginTop: '0.5rem' }}>Emergency Alert</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Send an emergency alert to notify nearby users and emergency services</p>
        </div>

        {activeAlert ? (
          <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', padding: '2rem', textAlign: 'center' }}>
            <Badge status={activeAlert.status} label={`Emergency ${activeAlert.status}`} />
            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: '1rem 0 0.5rem', textTransform: 'capitalize' }}>
              {activeAlert.type} Emergency
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginBottom: '1.5rem' }}>
              Alert is active. Emergency services have been notified.
            </p>
            <Button variant="success" onClick={() => resolveMutation.mutate(activeAlert.id)} loading={resolveMutation.isPending}>
              Mark as Resolved
            </Button>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {EMERGENCY_TYPES.map(({ value, label, icon: Icon, color }) => (
                <button
                  key={value}
                  onClick={() => setSelectedType(value)}
                  style={{
                    padding: '1rem 0.5rem', borderRadius: 'var(--radius)', border: `2px solid ${selectedType === value ? color : 'var(--border)'}`,
                    background: selectedType === value ? `${color}22` : 'var(--bg-card)',
                    color: selectedType === value ? color : 'var(--text-muted)',
                    cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem',
                    fontWeight: selectedType === value ? 700 : 400, fontSize: '0.85rem', transition: 'all 0.15s',
                  }}
                >
                  <Icon size={28} />
                  {label}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <div style={{ flex: 1 }}><Input label="Latitude" placeholder="10.6918" value={position.latitude} onChange={(e) => setPosition({ ...position, latitude: e.target.value })} /></div>
              <div style={{ flex: 1 }}><Input label="Longitude" placeholder="-61.2225" value={position.longitude} onChange={(e) => setPosition({ ...position, longitude: e.target.value })} /></div>
            </div>
            <Button variant="secondary" size="sm" fullWidth onClick={getLocation} style={{ marginBottom: '1rem' }}>Get My Location Automatically</Button>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>Additional Details (optional)</label>
              <textarea
                value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the situation..."
                rows={3}
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', padding: '0.6rem 0.9rem', fontSize: '0.95rem', width: '100%', resize: 'vertical' }}
              />
            </div>

            <Button
              variant="danger"
              fullWidth
              loading={triggerMutation.isPending}
              onClick={handleSOS}
              style={{ padding: '1rem', fontSize: '1.1rem', fontWeight: 800 }}
            >
              <MdSos size={24} /> SEND SOS ALERT
            </Button>
          </>
        )}
      </div>
    </Layout>
  );
};

export default EmergencyPage;
