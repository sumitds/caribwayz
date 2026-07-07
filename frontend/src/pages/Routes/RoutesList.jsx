import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRoutes, startNavigation, completeRoute } from '../../api/routes';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Badge from '../../components/UI/Badge';
import Modal from '../../components/UI/Modal';
import RouteCreate from './RouteCreate';
import { MdAdd, MdRoute, MdPlayArrow, MdCheckCircle, MdNavigation } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

const RoutesList = () => {
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['routes'],
    queryFn: () => getRoutes(),
    select: (res) => res.data.data.routes,
  });

  const startMutation = useMutation({
    mutationFn: startNavigation,
    onSuccess: () => { queryClient.invalidateQueries(['routes']); toast.success('Navigation started!'); },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to start'),
  });

  const completeMutation = useMutation({
    mutationFn: completeRoute,
    onSuccess: () => { queryClient.invalidateQueries(['routes']); toast.success('Route completed!'); },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to complete'),
  });

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>My Routes</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Plan and track your navigation routes</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <MdAdd size={18} /> New Route
        </Button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading routes...</div>
      ) : data?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>
          <MdRoute size={48} style={{ marginBottom: '1rem', opacity: 0.4 }} />
          <p>No routes yet. Create your first route!</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {data?.map((route) => (
            <div key={route.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.2rem 1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
                  <MdRoute size={18} color="var(--primary)" />
                  <span style={{ fontWeight: 600 }}>{route.route_name || 'Unnamed Route'}</span>
                  <Badge status={route.status} label={route.status} />
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <span>{route.distance ? `${route.distance} km` : '—'}</span>
                  <span>{route.eta ? `~${route.eta} min ETA` : '—'}</span>
                  <span>{formatDistanceToNow(new Date(route.created_at), { addSuffix: true })}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Button size="sm" variant="secondary" onClick={() => navigate(`/routes/${route.id}`)}>
                  View
                </Button>
                {route.status === 'planned' && (
                  <Button size="sm" loading={startMutation.isPending} onClick={() => startMutation.mutate(route.id)}>
                    <MdPlayArrow size={15} /> Start
                  </Button>
                )}
                {route.status === 'in-progress' && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => navigate(`/routes/${route.id}`)}>
                      <MdNavigation size={15} /> Navigate
                    </Button>
                    <Button size="sm" variant="success" loading={completeMutation.isPending} onClick={() => completeMutation.mutate(route.id)}>
                      <MdCheckCircle size={15} /> Done
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <Modal title="Create New Route" onClose={() => setShowCreate(false)}>
          <RouteCreate onSuccess={() => { setShowCreate(false); queryClient.invalidateQueries(['routes']); }} />
        </Modal>
      )}
    </Layout>
  );
};

export default RoutesList;
