import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createRoute } from '../../api/routes';
import Input from '../../components/UI/Input';
import Button from '../../components/UI/Button';
import toast from 'react-hot-toast';
import { MdAdd, MdDelete } from 'react-icons/md';

const RouteCreate = ({ onSuccess }) => {
  const [form, setForm] = useState({
    route_name: '', start_lat: '', start_lng: '', start_address: '',
    end_lat: '', end_lng: '', end_address: '',
  });
  const [stops, setStops] = useState([]);

  const mutation = useMutation({
    mutationFn: createRoute,
    onSuccess: () => { toast.success('Route created!'); onSuccess?.(); },
    onError: (err) => toast.error(err.response?.data?.message || 'Failed to create route'),
  });

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const addStop = () => setStops([...stops, { stop_name: '', latitude: '', longitude: '' }]);
  const removeStop = (i) => setStops(stops.filter((_, idx) => idx !== i));
  const updateStop = (i, field, value) => {
    const updated = [...stops];
    updated[i][field] = value;
    setStops(updated);
  };

  const useMyLocation = (field) => {
    navigator.geolocation?.getCurrentPosition(
      ({ coords }) => setForm((f) => ({ ...f, [`${field}_lat`]: coords.latitude.toFixed(6), [`${field}_lng`]: coords.longitude.toFixed(6) })),
      () => toast.error('Location unavailable')
    );
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.start_lat || !form.start_lng || !form.end_lat || !form.end_lng) {
      return toast.error('Start and end coordinates are required');
    }
    mutation.mutate({ ...form, stops });
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Input label="Route Name (optional)" name="route_name" placeholder="e.g., Morning Delivery" value={form.route_name} onChange={handleChange} />

      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
        <p style={{ fontWeight: 600, marginBottom: '0.75rem', fontSize: '0.9rem' }}>Start Point</p>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <div style={{ flex: 1 }}><Input label="Latitude" name="start_lat" placeholder="10.6918" value={form.start_lat} onChange={handleChange} /></div>
          <div style={{ flex: 1 }}><Input label="Longitude" name="start_lng" placeholder="-61.2225" value={form.start_lng} onChange={handleChange} /></div>
        </div>
        <Input label="Address (optional)" name="start_address" placeholder="Start address" value={form.start_address} onChange={handleChange} />
        <Button type="button" size="sm" variant="secondary" style={{ marginTop: '0.5rem' }} onClick={() => useMyLocation('start')}>Use My Location</Button>
      </div>

      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
        <p style={{ fontWeight: 600, marginBottom: '0.75rem', fontSize: '0.9rem' }}>End Point</p>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <div style={{ flex: 1 }}><Input label="Latitude" name="end_lat" placeholder="10.6521" value={form.end_lat} onChange={handleChange} /></div>
          <div style={{ flex: 1 }}><Input label="Longitude" name="end_lng" placeholder="-61.5194" value={form.end_lng} onChange={handleChange} /></div>
        </div>
        <Input label="Address (optional)" name="end_address" placeholder="End address" value={form.end_address} onChange={handleChange} />
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <p style={{ fontWeight: 600, fontSize: '0.9rem' }}>Stops (optional)</p>
          <Button type="button" size="sm" variant="secondary" onClick={addStop}><MdAdd size={15} /> Add Stop</Button>
        </div>
        {stops.map((stop, i) => (
          <div key={i} style={{ background: 'var(--bg-input)', borderRadius: 'var(--radius)', padding: '0.75rem', marginBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
            <div style={{ flex: 2 }}><Input label="Stop Name" placeholder={`Stop ${i + 1}`} value={stop.stop_name} onChange={(e) => updateStop(i, 'stop_name', e.target.value)} /></div>
            <div style={{ flex: 1 }}><Input label="Lat" placeholder="10.68" value={stop.latitude} onChange={(e) => updateStop(i, 'latitude', e.target.value)} /></div>
            <div style={{ flex: 1 }}><Input label="Lng" placeholder="-61.22" value={stop.longitude} onChange={(e) => updateStop(i, 'longitude', e.target.value)} /></div>
            <Button type="button" size="sm" variant="danger" onClick={() => removeStop(i)}><MdDelete size={15} /></Button>
          </div>
        ))}
      </div>

      <Button type="submit" fullWidth loading={mutation.isPending}>Create Route</Button>
    </form>
  );
};

export default RouteCreate;
