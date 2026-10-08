import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAdminUsers, updateUserStatus, setResponderAccess } from '../../api/admin';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Badge from '../../components/UI/Badge';
import Input from '../../components/UI/Input';
import { MdPeople } from 'react-icons/md';
import { formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

const AdminUsers = () => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', search, statusFilter],
    queryFn: () => getAdminUsers({
      search: search || undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
    }),
    select: (res) => res.data.data,
  });

  const responderMutation = useMutation({
    mutationFn: ({ id, approved }) => setResponderAccess(id, approved),
    onSuccess: (_, { approved }) => {
      queryClient.invalidateQueries(['admin-users']);
      toast.success(approved ? 'Emergency desk access granted' : 'Emergency desk access removed');
    },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to change desk access'),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }) => updateUserStatus(id, status),
    onSuccess: (_, { status }) => { queryClient.invalidateQueries(['admin-users']); toast.success(`User ${status}`); },
    onError: () => toast.error('Failed to update user'),
  });

  return (
    <Layout>
      <div style={{ marginBottom: '1.75rem' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <MdPeople size={26} color="#F5A623" /> Manage Users
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
          {data?.total ? `${data.total} total users` : 'View and manage all CaribWayz accounts'}
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.2rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 240, maxWidth: 380 }}>
          <Input placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {['all', 'active', 'suspended'].map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: '0.4rem 1rem', borderRadius: 20, border: 'none', cursor: 'pointer',
            background: statusFilter === s ? '#CC2229' : 'var(--bg-card)',
            color: statusFilter === s ? '#fff' : 'var(--text-muted)',
            fontWeight: 600, fontSize: '0.82rem', textTransform: 'capitalize',
          }}>
            {s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Loading users...</div>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: '#111' }}>
                  {['Name', 'Email', 'Phone', 'Role', 'Status', 'Desk access', 'Joined', 'Actions'].map((h) => (
                    <th key={h} style={{ padding: '0.85rem 1rem', textAlign: 'left', fontWeight: 700, color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.users?.map((user) => (
                  <tr key={user.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.1s' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#1e1e1e'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '0.85rem 1rem', fontWeight: 600 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg, #CC2229, #F5A623)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '0.78rem', color: '#fff', flexShrink: 0 }}>
                          {user.name?.trim()?.[0]?.toUpperCase() || '?'}
                        </div>
                        {user.name?.trim() ? user.name : <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontStyle: 'italic' }}>Name not given</span>}
                      </div>
                    </td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)' }}>{user.email}</td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)' }}>{user.phone || '—'}</td>
                    <td style={{ padding: '0.85rem 1rem' }}><Badge status={user.role} label={user.role} /></td>
                    <td style={{ padding: '0.85rem 1rem' }}><Badge status={user.status} label={user.status} /></td>
                    <td style={{ padding: '0.85rem 1rem', whiteSpace: 'nowrap' }}>
                      {user.role === 'admin' ? (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Admin (always)</span>
                      ) : user.is_responder ? (
                        <Button size="sm" variant="secondary" loading={responderMutation.isPending && responderMutation.variables?.id === user.id}
                          onClick={() => responderMutation.mutate({ id: user.id, approved: false })}>
                          Remove access
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" loading={responderMutation.isPending && responderMutation.variables?.id === user.id}
                          onClick={() => responderMutation.mutate({ id: user.id, approved: true })}>
                          Grant access
                        </Button>
                      )}
                    </td>
                    <td style={{ padding: '0.85rem 1rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDistanceToNow(new Date(user.created_at), { addSuffix: true })}</td>
                    <td style={{ padding: '0.85rem 1rem' }}>
                      {user.status === 'active' ? (
                        <Button size="sm" variant="danger" loading={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: user.id, status: 'suspended' })}>
                          Suspend
                        </Button>
                      ) : (
                        <Button size="sm" variant="success" loading={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: user.id, status: 'active' })}>
                          Activate
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.users?.length === 0 && (
            <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>No users found</div>
          )}
        </div>
      )}
    </Layout>
  );
};

export default AdminUsers;
