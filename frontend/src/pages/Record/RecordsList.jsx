import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { getMyRecords, deleteRecord } from '../../api/records';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import { MdAdd, MdDescription, MdDelete, MdChevronRight, MdAttachFile } from 'react-icons/md';
import { formatDistanceToNow, format } from 'date-fns';
import toast from 'react-hot-toast';

const SEVERITIES = ['all', 'minor', 'major', 'fatal'];
const TYPES = ['all', 'accident', 'collision', 'hit_and_run', 'vehicle_damage', 'theft', 'other'];

const severityMeta = {
  minor:  { color: '#2D8C00', bg: '#2D8C0018' },
  major:  { color: '#F5A623', bg: '#F5A62318' },
  fatal:  { color: '#CC2229', bg: '#CC222918' },
};

const RecordsList = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['my-records', severityFilter, typeFilter],
    queryFn: () => getMyRecords({
      severity: severityFilter !== 'all' ? severityFilter : undefined,
      type: typeFilter !== 'all' ? typeFilter : undefined,
    }),
    select: (res) => res.data.data,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteRecord,
    onSuccess: () => { queryClient.invalidateQueries(['my-records']); toast.success('Record deleted'); },
    onError: () => toast.error('Failed to delete record'),
  });

  const confirmDelete = (e, id) => {
    e.stopPropagation();
    if (window.confirm('Delete this incident record?')) deleteMutation.mutate(id);
  };

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <MdDescription size={26} color="#F5A623" /> Incident Records
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
            {data?.total ? `${data.total} recorded incidents` : 'Log accidents for police reports & insurance claims'}
          </p>
        </div>
        <Button onClick={() => navigate('/record/new')}>
          <MdAdd size={18} /> Log Incident
        </Button>
      </div>

      {/* Severity filter */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {SEVERITIES.map((s) => {
          const meta = severityMeta[s] || {};
          const isActive = severityFilter === s;
          return (
            <button key={s} onClick={() => setSeverityFilter(s)} style={{
              padding: '0.35rem 1rem', borderRadius: 20, border: `1px solid ${isActive ? (meta.color || '#CC2229') : 'var(--border)'}`,
              cursor: 'pointer', fontWeight: 700, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em',
              background: isActive ? (meta.bg || '#CC222918') : 'transparent',
              color: isActive ? (meta.color || '#CC2229') : 'var(--text-muted)',
            }}>
              {s === 'all' ? 'All' : s}
            </button>
          );
        })}
      </div>

      {/* Type filter */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1.4rem', flexWrap: 'wrap' }}>
        {TYPES.map((t) => (
          <button key={t} onClick={() => setTypeFilter(t)} style={{
            padding: '0.25rem 0.75rem', borderRadius: 20, border: 'none', cursor: 'pointer',
            background: typeFilter === t ? '#F5A62318' : 'var(--bg-card)',
            color: typeFilter === t ? '#F5A623' : 'var(--text-muted)',
            fontWeight: 600, fontSize: '0.78rem', textTransform: 'capitalize',
          }}>
            {t === 'all' ? 'All Types' : t.replace('_', ' ')}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading records...</div>
      ) : data?.records?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
          <MdDescription size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
          <p style={{ marginBottom: '0.5rem', fontWeight: 600 }}>No incident records yet</p>
          <p style={{ fontSize: '0.83rem' }}>Log an incident to generate documentation for police or insurance use.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          {data?.records?.map((rec) => {
            const meta = severityMeta[rec.severity] || severityMeta.minor;
            return (
              <div
                key={rec.id}
                onClick={() => navigate(`/record/${rec.id}`)}
                style={{
                  background: 'var(--bg-card)', border: `1px solid ${meta.color}33`,
                  borderRadius: 'var(--radius)', padding: '1.1rem 1.3rem',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = meta.color}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = `${meta.color}33`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                  <div style={{ flex: 1 }}>
                    {/* Header row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.06em',
                        color: meta.color, background: meta.bg,
                        padding: '0.18rem 0.6rem', borderRadius: 20, border: `1px solid ${meta.color}55`,
                        textTransform: 'uppercase',
                      }}>
                        {rec.severity}
                      </span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'monospace', letterSpacing: '0.04em' }}>
                        {rec.incident_id}
                      </span>
                      {rec.parish && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{rec.parish}</span>
                      )}
                    </div>

                    {/* Type + description */}
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, textTransform: 'capitalize', marginBottom: '0.25rem' }}>
                      {rec.type.replace('_', ' ')}
                    </div>
                    {rec.description && (
                      <p style={{ fontSize: '0.83rem', color: 'var(--text-muted)', marginBottom: '0.4rem', lineHeight: 1.4,
                        overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {rec.description}
                      </p>
                    )}

                    {/* Footer row */}
                    <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span>Logged {formatDistanceToNow(new Date(rec.created_at), { addSuffix: true })}</span>
                      {rec.occurred_at && (
                        <span>Occurred {format(new Date(rec.occurred_at), 'dd MMM yyyy HH:mm')}</span>
                      )}
                      {rec.image_count > 0 && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <MdAttachFile size={12} /> {rec.image_count}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                    <button
                      onClick={(e) => confirmDelete(e, rec.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', padding: '0.25rem' }}
                      onMouseEnter={(e) => e.currentTarget.style.color = '#CC2229'}
                      onMouseLeave={(e) => e.currentTarget.style.color = '#888'}
                    >
                      <MdDelete size={16} />
                    </button>
                    <MdChevronRight size={20} color="#888" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Layout>
  );
};

export default RecordsList;
