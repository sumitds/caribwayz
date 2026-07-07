import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import { getNearbyReports } from '../api/reports';
import { getPois } from '../api/pois';
import Layout from '../components/Layout/Layout';
import Badge from '../components/UI/Badge';
import Button from '../components/UI/Button';
import { MdMyLocation, MdWarning, MdLocalGasStation, MdRestaurant, MdHotel } from 'react-icons/md';
import toast from 'react-hot-toast';

// Fix default Leaflet icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const reportColors = {
  traffic: '#f59e0b', accident: '#ef4444', police: '#3b82f6',
  construction: '#f97316', hazard: '#ef4444',
};

const createColoredIcon = (color) => new L.DivIcon({
  html: `<div style="background:${color};width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>`,
  className: '',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const LocationMarker = ({ setPosition }) => {
  useMapEvents({
    locationfound(e) { setPosition([e.latlng.lat, e.latlng.lng]); },
  });
  return null;
};

const Dashboard = () => {
  const [position, setPosition] = useState([10.6918, -61.2225]); // Default: Trinidad
  const [showReports, setShowReports] = useState(true);
  const [showPois, setShowPois] = useState(false);
  const [mapRef, setMapRef] = useState(null);

  const { data: reportsData } = useQuery({
    queryKey: ['nearby-reports', position],
    queryFn: () => getNearbyReports({ lat: position[0], lng: position[1], radius: 10 }),
    select: (res) => res.data.data.reports,
    enabled: showReports,
  });

  const { data: poisData } = useQuery({
    queryKey: ['pois', position],
    queryFn: () => getPois({ lat: position[0], lng: position[1], radius: 5, limit: 30 }),
    select: (res) => res.data.data.pois,
    enabled: showPois,
  });

  const locateMe = () => {
    if (!navigator.geolocation) return toast.error('Geolocation not supported');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setPosition([latitude, longitude]);
        if (mapRef) mapRef.setView([latitude, longitude], 14);
        toast.success('Location found!');
      },
      () => toast.error('Unable to get your location')
    );
  };

  const poiIcons = { gas: MdLocalGasStation, restaurant: MdRestaurant, hotel: MdHotel };

  return (
    <Layout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: 'calc(100vh - 4rem)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Map & Navigation</h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Live map with reports and points of interest</p>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <Button variant={showReports ? 'primary' : 'secondary'} size="sm" onClick={() => setShowReports(!showReports)}>
              <MdWarning size={15} /> Reports
            </Button>
            <Button variant={showPois ? 'primary' : 'secondary'} size="sm" onClick={() => setShowPois(!showPois)}>
              POIs
            </Button>
            <Button size="sm" onClick={locateMe}>
              <MdMyLocation size={15} /> My Location
            </Button>
          </div>
        </div>

        <div style={{ flex: 1, borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)', minHeight: 400 }}>
          <MapContainer
            center={position}
            zoom={13}
            style={{ height: '100%', width: '100%' }}
            ref={setMapRef}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <LocationMarker setPosition={setPosition} />

            <Marker position={position}>
              <Popup>You are here</Popup>
            </Marker>

            {showReports && reportsData?.map((report) => (
              <React.Fragment key={report.id}>
                <Marker
                  position={[report.latitude, report.longitude]}
                  icon={createColoredIcon(reportColors[report.type] || '#94a3b8')}
                >
                  <Popup>
                    <div style={{ minWidth: 160 }}>
                      <strong style={{ textTransform: 'capitalize' }}>{report.type}</strong>
                      <br />
                      <Badge status={report.severity} label={report.severity} />
                      <br />
                      <small>{report.description || 'No description'}</small>
                      <br />
                      <small style={{ color: '#888' }}>{report.distance_km} km away</small>
                    </div>
                  </Popup>
                </Marker>
                {report.severity === 'critical' && (
                  <Circle center={[report.latitude, report.longitude]} radius={300} pathOptions={{ color: '#ef4444', fillOpacity: 0.1 }} />
                )}
              </React.Fragment>
            ))}

            {showPois && poisData?.map((poi) => (
              <Marker
                key={poi.id}
                position={[poi.latitude, poi.longitude]}
                icon={createColoredIcon('#0ea5e9')}
              >
                <Popup>
                  <div style={{ minWidth: 150 }}>
                    <strong>{poi.name}</strong><br />
                    <Badge status={poi.category} label={poi.category} /><br />
                    {poi.phone && <small>{poi.phone}</small>}
                    {poi.rating > 0 && <><br /><small>Rating: {poi.rating}/5</small></>}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        {showReports && reportsData?.length > 0 && (
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {reportsData.slice(0, 4).map((r) => (
              <div key={r.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.75rem 1rem', flex: '1 1 180px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                  <MdWarning size={16} color={reportColors[r.type] || '#94a3b8'} />
                  <span style={{ fontWeight: 600, textTransform: 'capitalize', fontSize: '0.88rem' }}>{r.type}</span>
                  <Badge status={r.severity} label={r.severity} />
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{r.distance_km} km away</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
};

export default Dashboard;
