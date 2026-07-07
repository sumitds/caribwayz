import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getGroupDetails, leaveGroup, updateGroupLocation } from '../../api/groups';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import { MdContentCopy, MdExitToApp } from 'react-icons/md';
import toast from 'react-hot-toast';
import { database, isConfigured } from '../../config/firebase';
import { ref, onValue, off } from 'firebase/database';

const GroupDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [sharingLocation, setSharingLocation] = useState(false);
  const [watchId, setWatchId] = useState(null);
  const [liveLocations, setLiveLocations] = useState({});

  // Subscribe to live member locations from Firebase Realtime DB
  useEffect(() => {
    if (!isConfigured || !database) return;
    const locRef = ref(database, `groups/${id}/locations`);
    onValue(locRef, (snapshot) => {
      setLiveLocations(snapshot.val() || {});
    });
    return () => off(locRef);
  }, [id]);

  const { data, isLoading } = useQuery({
    queryKey: ['group', id],
    queryFn: () => getGroupDetails(id),
    select: (res) => res.data.data,
    refetchInterval: 10000,
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveGroup(id),
    onSuccess: () => { toast.success('Left group'); navigate('/groups'); },
  });

  const locationMutation = useMutation({
    mutationFn: (coords) => updateGroupLocation(id, coords),
  });

  const toggleLocationSharing = () => {
    if (sharingLocation) {
      if (watchId) navigator.geolocation.clearWatch(watchId);
      setWatchId(null);
      setSharingLocation(false);
      toast.success('Location sharing stopped');
    } else {
      const wid = navigator.geolocation.watchPosition(
        ({ coords }) => locationMutation.mutate({ latitude: coords.latitude, longitude: coords.longitude }),
        () => toast.error('Location unavailable'),
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
      setWatchId(wid);
      setSharingLocation(true);
      toast.success('Location sharing started');
    }
  };

  useEffect(() => {
    return () => { if (watchId) navigator.geolocation.clearWatch(watchId); };
  }, [watchId]);

  if (isLoading) return <Layout><div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading group...</div></Layout>;
  if (!data) return null;

  const { group, members } = data;

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>{group.group_name}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.4rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Join Code:</span>
            <span style={{ fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 700, letterSpacing: '0.15em', color: 'var(--primary)' }}>{group.join_code}</span>
            <button
              onClick={() => { navigator.clipboard.writeText(group.join_code); toast.success('Copied!'); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}
            >
              <MdContentCopy size={16} />
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <Button variant={sharingLocation ? 'danger' : 'primary'} size="sm" onClick={toggleLocationSharing}>
            {sharingLocation ? 'Stop Sharing' : 'Share Location'}
          </Button>
          <Button variant="secondary" size="sm" loading={leaveMutation.isPending} onClick={() => leaveMutation.mutate()}>
            <MdExitToApp size={15} /> Leave
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '1.5rem', alignItems: 'start' }}>
        <div style={{ height: 420, borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
          <MapContainer center={[10.6918, -61.2225]} zoom={12} style={{ height: '100%', width: '100%' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; OpenStreetMap' />
            {group.destination_lat && (
              <Marker position={[parseFloat(group.destination_lat), parseFloat(group.destination_lng)]}>
                <Popup><strong>Destination</strong>{group.destination_address && <><br />{group.destination_address}</>}</Popup>
              </Marker>
            )}
            {/* Live member locations from Firebase Realtime DB */}
            {Object.entries(liveLocations).map(([userId, loc]) => {
              const member = members.find((m) => String(m.user_id) === userId);
              return (
                <Marker key={userId} position={[loc.lat, loc.lng]}>
                  <Popup>
                    <strong>{member?.name || 'Member'}</strong><br />
                    <small style={{ color: '#888' }}>Updated {new Date(loc.updatedAt).toLocaleTimeString()}</small>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>
        </div>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.2rem' }}>
          <h3 style={{ fontWeight: 700, marginBottom: '1rem', fontSize: '1rem' }}>Members ({members.length})</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {members.map((m) => {
              const isLive = !!liveLocations[String(m.user_id)];
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.85rem', flexShrink: 0 }}>
                    {m.name?.[0]?.toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.87rem', fontWeight: 600 }}>{m.name}</div>
                    {m.user_id === group.created_by && <div style={{ fontSize: '0.72rem', color: 'var(--primary)' }}>Leader</div>}
                  </div>
                  {isLive && (
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} title="Sharing location" />
                  )}
                </div>
              );
            })}
          </div>
          {!isConfigured && (
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
              Live tracking requires Firebase configuration.
            </p>
          )}
        </div>
      </div>
    </Layout>
  );
};

export default GroupDetail;
