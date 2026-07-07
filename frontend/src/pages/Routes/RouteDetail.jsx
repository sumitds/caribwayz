import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteById, startNavigation, completeRoute } from '../../api/routes';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Badge from '../../components/UI/Badge';
import { MdArrowBack, MdPlayArrow, MdCheckCircle } from 'react-icons/md';
import toast from 'react-hot-toast';

const RouteDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['route', id],
    queryFn: () => getRouteById(id),
    select: (res) => res.data.data,
  });

  const startMutation = useMutation({
    mutationFn: () => startNavigation(id),
    onSuccess: () => { queryClient.invalidateQueries(['route', id]); queryClient.invalidateQueries(['routes']); toast.success('Navigation started!'); },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to start'),
  });

  const completeMutation = useMutation({
    mutationFn: () => completeRoute(id),
    onSuccess: () => { queryClient.invalidateQueries(['route', id]); queryClient.invalidateQueries(['routes']); toast.success('Route completed!'); },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to complete'),
  });

  if (isLoading) return <Layout><div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading route...</div></Layout>;
  if (!data) return null;

  const { route, stops } = data;

  const startPos = [parseFloat(route.start_lat), parseFloat(route.start_lng)];
  const endPos = [parseFloat(route.end_lat), parseFloat(route.end_lng)];
  const stopPositions = (stops || []).map((s) => [parseFloat(s.latitude), parseFloat(s.longitude)]);
  const polylinePositions = [startPos, ...stopPositions, endPos];

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Button variant="secondary" size="sm" onClick={() => navigate('/routes')}>
            <MdArrowBack size={16} /> Back
          </Button>
          <div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>{route.route_name || 'Unnamed Route'}</h2>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.3rem', fontSize: '0.82rem', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span>{route.distance ? `${route.distance} km` : '—'}</span>
              <span>{route.eta ? `~${route.eta} min ETA` : '—'}</span>
              <Badge status={route.status} label={route.status} />
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {route.status === 'planned' && (
            <Button size="sm" loading={startMutation.isPending} onClick={() => startMutation.mutate()}>
              <MdPlayArrow size={15} /> Start Navigation
            </Button>
          )}
          {route.status === 'in-progress' && (
            <Button size="sm" variant="success" loading={completeMutation.isPending} onClick={() => completeMutation.mutate()}>
              <MdCheckCircle size={15} /> Mark Complete
            </Button>
          )}
        </div>
      </div>

      <div style={{ height: 480, borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
        <MapContainer center={startPos} zoom={12} style={{ height: '100%', width: '100%' }}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; OpenStreetMap' />

          {/* Route polyline */}
          <Polyline positions={polylinePositions} color="var(--primary, #3b82f6)" weight={4} opacity={0.8} />

          {/* Start marker */}
          <Marker position={startPos}>
            <Popup><strong>Start</strong>{route.start_address && <><br />{route.start_address}</>}</Popup>
          </Marker>

          {/* Stop markers */}
          {(stops || []).map((stop, i) => (
            <Marker key={stop.id} position={[parseFloat(stop.latitude), parseFloat(stop.longitude)]}>
              <Popup><strong>Stop {i + 1}</strong>{stop.stop_name && <><br />{stop.stop_name}</>}</Popup>
            </Marker>
          ))}

          {/* End marker */}
          <Marker position={endPos}>
            <Popup><strong>Destination</strong>{route.end_address && <><br />{route.end_address}</>}</Popup>
          </Marker>
        </MapContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginTop: '1.2rem' }}>
        {[
          { label: 'From', value: route.start_address || `${route.start_lat}, ${route.start_lng}` },
          { label: 'To', value: route.end_address || `${route.end_lat}, ${route.end_lng}` },
          { label: 'Distance', value: route.distance ? `${route.distance} km` : '—' },
          { label: 'ETA', value: route.eta ? `~${route.eta} min` : '—' },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem 1.1rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
            <div style={{ fontSize: '0.92rem', fontWeight: 500 }}>{value}</div>
          </div>
        ))}
      </div>
    </Layout>
  );
};

export default RouteDetail;
