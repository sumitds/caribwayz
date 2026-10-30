import React from 'react';
import { MapContainer, TileLayer, CircleMarker, useMapEvents } from 'react-leaflet';

// Jamaica, as the Emergency Desk map opens.
const DEFAULT_CENTER = [18.1096, -77.2975];

const ClickToPlace = ({ onPick }) => {
  useMapEvents({
    click(e) { onPick(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))); },
  });
  return null;
};

/**
 * A small map: click to set the location. [latitude] and [longitude] are the
 * form's text values; the marker shows only while both are a valid position.
 */
const LocationPicker = ({ latitude, longitude, onPick, height = 220 }) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const placed = String(latitude).trim() !== '' && String(longitude).trim() !== '' &&
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  return (
    <div>
      <div style={{ height, borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
        <MapContainer center={placed ? [lat, lng] : DEFAULT_CENTER} zoom={placed ? 15 : 8} style={{ height: '100%', width: '100%' }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickToPlace onPick={onPick} />
          {placed && <CircleMarker center={[lat, lng]} radius={9} pathOptions={{ color: '#CC2229', fillOpacity: 0.7 }} />}
        </MapContainer>
      </div>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
        Click the map to place the business, or type the coordinates.
      </p>
    </div>
  );
};

export default LocationPicker;
