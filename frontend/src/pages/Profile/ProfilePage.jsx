import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile, getPreferences, updatePreferences } from '../../api/user';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Badge from '../../components/UI/Badge';
import { useAuth } from '../../context/AuthContext';
import { MdPerson, MdSettings } from 'react-icons/md';
import toast from 'react-hot-toast';

const Toggle = ({ label, checked, onChange }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0' }}>
    <span style={{ fontSize: '0.9rem' }}>{label}</span>
    <div
      onClick={onChange}
      style={{
        width: 42, height: 24, borderRadius: 12, background: checked ? 'var(--primary)' : 'var(--bg-input)',
        cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
      }}
    >
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: checked ? 21 : 3, transition: 'left 0.2s' }} />
    </div>
  </div>
);

const ProfilePage = () => {
  const { updateUser } = useAuth();
  const [tab, setTab] = useState('profile');
  const queryClient = useQueryClient();

  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
    select: (res) => res.data.data.user,
  });

  const { data: prefs } = useQuery({
    queryKey: ['preferences'],
    queryFn: () => getPreferences(),
    select: (res) => res.data.data.preferences,
  });

  const [profileForm, setProfileForm] = useState({ name: '', phone: '' });
  const [prefsForm, setPrefsForm] = useState({});

  React.useEffect(() => {
    if (profile) setProfileForm({ name: profile.name, phone: profile.phone || '' });
  }, [profile]);

  React.useEffect(() => {
    if (prefs) setPrefsForm(prefs);
  }, [prefs]);

  const profileMutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: (res) => { updateUser(res.data.data.user); queryClient.invalidateQueries(['profile']); toast.success('Profile updated!'); },
    onError: () => toast.error('Failed to update profile'),
  });

  const prefsMutation = useMutation({
    mutationFn: updatePreferences,
    onSuccess: () => { queryClient.invalidateQueries(['preferences']); toast.success('Preferences saved!'); },
    onError: () => toast.error('Failed to save preferences'),
  });

  return (
    <Layout>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.5rem' }}>Account Settings</h2>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          {[['profile', MdPerson, 'Profile'], ['preferences', MdSettings, 'Alert Preferences']].map(([key, Icon, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{ padding: '0.5rem 1.1rem', borderRadius: 'var(--radius)', border: 'none', background: tab === key ? 'var(--primary)' : 'var(--bg-card)', color: tab === key ? '#fff' : 'var(--text-muted)', cursor: 'pointer', fontWeight: 600, fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </div>

        {tab === 'profile' && profile && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
              <div style={{ width: 60, height: 60, borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 800 }}>
                {profile.name?.[0]?.toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{profile.name}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{profile.email}</div>
                <Badge status={profile.role} label={profile.role} />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <Input label="Full Name" value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} />
              <Input label="Phone Number" type="tel" value={profileForm.phone} onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })} />
              <Button loading={profileMutation.isPending} onClick={() => profileMutation.mutate(profileForm)}>Save Changes</Button>
            </div>
          </div>
        )}

        {tab === 'preferences' && prefs && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.5rem' }}>
            <h3 style={{ fontWeight: 700, marginBottom: '1rem', fontSize: '1rem' }}>Alert Notifications</h3>
            <div style={{ borderBottom: '1px solid var(--border)', marginBottom: '1rem', paddingBottom: '1rem' }}>
              {[
                ['alert_police', 'Police Alerts'],
                ['alert_construction', 'Construction Alerts'],
                ['alert_hazards', 'Road Hazards'],
                ['alert_traffic', 'Traffic Incidents'],
                ['alert_business', 'Business Updates'],
                ['alert_tourism', 'Tourism Events'],
              ].map(([key, label]) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={!!prefsForm[key]}
                  onChange={() => setPrefsForm({ ...prefsForm, [key]: !prefsForm[key] })}
                />
              ))}
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '0.5rem' }}>Priority Level</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {['critical', 'high', 'low'].map((level) => (
                  <button
                    key={level}
                    onClick={() => setPrefsForm({ ...prefsForm, priority_level: level })}
                    style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius)', border: `2px solid ${prefsForm.priority_level === level ? 'var(--primary)' : 'var(--border)'}`, background: prefsForm.priority_level === level ? 'rgba(14,165,233,0.15)' : 'var(--bg-input)', color: prefsForm.priority_level === level ? 'var(--primary)' : 'var(--text-muted)', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', textTransform: 'capitalize' }}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            <Button loading={prefsMutation.isPending} onClick={() => prefsMutation.mutate(prefsForm)}>Save Preferences</Button>
          </div>
        )}
      </div>
    </Layout>
  );
};

export default ProfilePage;
