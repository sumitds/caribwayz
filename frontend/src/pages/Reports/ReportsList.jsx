import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNearbyReports, confirmReport } from '../../api/reports';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Badge from '../../components/UI/Badge';
import Modal from '../../components/UI/Modal';
import ReportCreate from './ReportCreate';
import { MdAdd, MdWarning, MdThumbUp } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

const REPORT_TYPES = ['all', 'traffic', 'accident', 'police', 'construction', 'hazard'];

const ReportsList = () => {
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState('all');
  const [position, setPosition] = useState([10.6918, -61.2225]);
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['nearby-reports-list', position, filter],
    queryFn: () => getNearbyReports({ lat: position[0], lng: position[1], radius: 20, type: filter === 'all' ? undefined : filter }),
    select: (res) => res.data.data.reports,
  });

  const confirmMutation = useMutation({
    mutationFn: confirmReport,
    onSuccess: () => { queryClient.invalidateQueries(['nearby-reports-list']); toast.success('Report confirmed!'); },
    onError: (err) => toast.error(err.response?.data?.message || 'Already confirmed'),
  });

  const getMyLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by this browser');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setPosition([coords.latitude, coords.longitude]); toast.success('Location updated'); },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) toast.error('Location permission denied — please allow access in browser settings');
        else if (err.code === err.TIMEOUT) toast.error('Location request timed out — please try again');
        else toast.error('Location unavailable');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Community Reports</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Road incidents and hazards reported by drivers</p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <Button variant="secondary" size="sm" onClick={getMyLocation}>My Location</Button>
          <Button onClick={() => setShowCreate(true)}><MdAdd size={18} /> Report Incident</Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
        {REPORT_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            style={{
              padding: '0.35rem 0.85rem', borderRadius: '20px', border: 'none',
              background: filter === t ? 'var(--primary)' : 'var(--bg-card)',
              color: filter === t ? '#fff' : 'var(--text-muted)',
              cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading reports...</div>
      ) : data?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>
          <MdWarning size={48} style={{ marginBottom: '1rem', opacity: 0.3 }} />
          <p>No active reports in your area</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {data?.map((report) => (
            <div key={report.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.2rem 1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                  <MdWarning size={18} color="var(--warning)" />
                  <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{report.type}</span>
                  <Badge status={report.severity} label={report.severity} />
                  <Badge status={report.status} label={report.status} />
                </div>
                {report.description && <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>{report.description}</p>}
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <span>{report.distance_km} km away</span>
                  <span>By {report.reporter_name}</span>
                  <span>{formatDistanceToNow(new Date(report.created_at), { addSuffix: true })}</span>
                  <span>{report.confirmed_count} confirmations</span>
                </div>
              </div>
              <Button size="sm" variant="secondary" loading={confirmMutation.isPending} onClick={() => confirmMutation.mutate(report.id)}>
                <MdThumbUp size={15} /> Confirm
              </Button>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <Modal title="Report an Incident" onClose={() => setShowCreate(false)}>
          <ReportCreate currentPosition={position} onSuccess={() => { setShowCreate(false); queryClient.invalidateQueries(['nearby-reports-list']); }} />
        </Modal>
      )}
    </Layout>
  );
};

export default ReportsList;
