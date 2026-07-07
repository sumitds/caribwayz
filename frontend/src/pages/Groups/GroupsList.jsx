import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createGroup, joinGroup } from '../../api/groups';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Input from '../../components/UI/Input';
import Modal from '../../components/UI/Modal';
import { MdGroup, MdAdd, MdLogin } from 'react-icons/md';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

const GroupsList = () => {
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [createForm, setCreateForm] = useState({ group_name: '', destination_lat: '', destination_lng: '', destination_address: '' });
  const [joinCode, setJoinCode] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: createGroup,
    onSuccess: (res) => {
      const group = res.data.data.group;
      toast.success(`Group created! Join code: ${group.join_code}`);
      setShowCreate(false);
      navigate(`/groups/${group.id}`);
    },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to create group'),
  });

  const joinMutation = useMutation({
    mutationFn: (code) => joinGroup(code),
    onSuccess: (res) => {
      const group = res.data.data.group;
      toast.success('Joined group!');
      setShowJoin(false);
      navigate(`/groups/${group.id}`);
    },
    onError: (err) => toast.error(err.response?.data?.message || 'Invalid join code'),
  });

  const handleCreate = (e) => {
    e.preventDefault();
    if (!createForm.group_name.trim()) return toast.error('Group name required');
    createMutation.mutate(createForm);
  };

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Group Navigation</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Navigate together and track each other in real-time</p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <Button variant="secondary" onClick={() => setShowJoin(true)}><MdLogin size={18} /> Join Group</Button>
          <Button onClick={() => setShowCreate(true)}><MdAdd size={18} /> Create Group</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
        <div
          onClick={() => setShowCreate(true)}
          style={{ background: 'var(--bg-card)', border: '2px dashed var(--border)', borderRadius: 'var(--radius)', padding: '2.5rem', textAlign: 'center', cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' }}
        >
          <MdAdd size={40} style={{ marginBottom: '0.75rem' }} />
          <p style={{ fontWeight: 600 }}>Create a Group</p>
          <p style={{ fontSize: '0.82rem', marginTop: '0.25rem' }}>Start group navigation with a join code</p>
        </div>

        <div
          onClick={() => setShowJoin(true)}
          style={{ background: 'var(--bg-card)', border: '2px dashed var(--border)', borderRadius: 'var(--radius)', padding: '2.5rem', textAlign: 'center', cursor: 'pointer', color: 'var(--text-muted)', transition: 'all 0.15s' }}
        >
          <MdGroup size={40} style={{ marginBottom: '0.75rem' }} />
          <p style={{ fontWeight: 600 }}>Join a Group</p>
          <p style={{ fontSize: '0.82rem', marginTop: '0.25rem' }}>Enter a 6-character join code</p>
        </div>
      </div>

      {showCreate && (
        <Modal title="Create Navigation Group" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Input label="Group Name" placeholder="e.g., Family Trip" value={createForm.group_name} onChange={(e) => setCreateForm({ ...createForm, group_name: e.target.value })} />
            <Input label="Destination Address (optional)" placeholder="Destination" value={createForm.destination_address} onChange={(e) => setCreateForm({ ...createForm, destination_address: e.target.value })} />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <div style={{ flex: 1 }}><Input label="Dest. Latitude" placeholder="10.65" value={createForm.destination_lat} onChange={(e) => setCreateForm({ ...createForm, destination_lat: e.target.value })} /></div>
              <div style={{ flex: 1 }}><Input label="Dest. Longitude" placeholder="-61.51" value={createForm.destination_lng} onChange={(e) => setCreateForm({ ...createForm, destination_lng: e.target.value })} /></div>
            </div>
            <Button type="submit" fullWidth loading={createMutation.isPending}>Create Group</Button>
          </form>
        </Modal>
      )}

      {showJoin && (
        <Modal title="Join a Group" onClose={() => setShowJoin(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Input
              label="Join Code"
              placeholder="e.g., ABC123"
              maxLength={6}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.2em' }}
            />
            <Button fullWidth loading={joinMutation.isPending} onClick={() => { if (!joinCode.trim()) return toast.error('Enter a join code'); joinMutation.mutate(joinCode); }}>
              Join Group
            </Button>
          </div>
        </Modal>
      )}
    </Layout>
  );
};

export default GroupsList;
