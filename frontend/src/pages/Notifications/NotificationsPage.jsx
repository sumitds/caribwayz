import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotifications, markAsRead } from '../../api/notifications';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Badge from '../../components/UI/Badge';
import { MdNotifications, MdDoneAll } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

const NotificationsPage = () => {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => getNotifications({ limit: 50 }),
    select: (res) => res.data.data,
  });

  const markReadMutation = useMutation({
    mutationFn: () => markAsRead(null),
    onSuccess: () => { queryClient.invalidateQueries(['notifications']); toast.success('All marked as read'); },
  });

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Notifications</h2>
          {data?.unread_count > 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{data.unread_count} unread</p>
          )}
        </div>
        {data?.unread_count > 0 && (
          <Button variant="secondary" size="sm" loading={markReadMutation.isPending} onClick={() => markReadMutation.mutate()}>
            <MdDoneAll size={16} /> Mark All Read
          </Button>
        )}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading...</div>
      ) : data?.notifications?.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>
          <MdNotifications size={48} style={{ marginBottom: '1rem', opacity: 0.3 }} />
          <p>No notifications yet</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {data?.notifications?.map((n) => (
            <div
              key={n.id}
              style={{
                background: n.is_read ? 'var(--bg-card)' : 'rgba(14,165,233,0.08)',
                border: `1px solid ${n.is_read ? 'var(--border)' : 'rgba(14,165,233,0.3)'}`,
                borderRadius: 'var(--radius)', padding: '1rem 1.3rem',
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                  {!n.is_read && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />}
                  <span style={{ fontWeight: 600, fontSize: '0.92rem' }}>{n.title}</span>
                  <Badge status={n.type} label={n.type} />
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{n.message}</p>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
};

export default NotificationsPage;
