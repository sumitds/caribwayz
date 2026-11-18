import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import {
  MdSos, MdPhone, MdMap, MdCheckCircle, MdUndo, MdPanTool, MdVolumeUp, MdVolumeOff, MdInfoOutline,
} from 'react-icons/md';
import toast from 'react-hot-toast';
import Layout from '../../components/Layout/Layout';
import Button from '../../components/UI/Button';
import Modal from '../../components/UI/Modal';
import { useAuth } from '../../context/AuthContext';
import {
  listEmergencies, acknowledgeEmergency, releaseEmergency, addressEmergency,
} from '../../api/emergency';
import {
  typeLabel, groupAlerts, newlyWaiting, formatAgo, isOverdue, mapLink, formatCoordinates,
  hasLocation, telLink, reporterLabel, pageTitle, errorMessage, deskStatusOf, deskStatusLabel, canMarkAddressed,
} from './deskModel';

/** How often the queue is refreshed. An SOS should reach the desk within seconds. */
const REFRESH_MS = 10000;

/** Jamaica, the launch territory, until the queue has a location to fit. */
const DEFAULT_CENTER = [18.1096, -77.2975];

const SOUND_KEY = 'cw_desk_sound';

/** A short two-tone alert, generated so no audio file is needed. */
const playAlertTone = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.25);
      osc.stop(ctx.currentTime + i * 0.25 + 0.2);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch {
    // The browser blocked audio until the operator interacts with the page;
    // the tab title and the highlighted card still show the new alert.
  }
};

const readSoundPref = () => {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
};

/**
 * One desk action (acknowledge, return to queue, mark Addressed). Whatever the
 * outcome, the queue is refetched, so a 409 "already taken" immediately shows
 * who has it.
 */
const useDeskAction = (fn, successMessage, setBusyId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alert) => fn(alert.id),
    onMutate: (alert) => setBusyId(alert.id),
    onSuccess: (res) => toast.success(res.data.message || successMessage),
    onError: (err, alert) => toast.error(errorMessage(err, `Could not update the ${typeLabel(alert.type).toLowerCase()} alert`)),
    onSettled: () => {
      setBusyId(null);
      queryClient.invalidateQueries({ queryKey: ['desk-alerts'] });
    },
  });
};

const sectionTitle = { fontSize: '0.8rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '1.25rem 0 0.6rem' };

const STATUS_COLORS = { pending: '#CC2229', acknowledged: '#2D8C00' };

const StatusChip = ({ alert }) => (
  <span
    data-testid={`desk-status-${alert.id}`}
    style={{
      fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase',
      color: STATUS_COLORS[deskStatusOf(alert)] || 'var(--text-muted)',
      border: '1px solid currentColor', borderRadius: 999, padding: '0.1rem 0.5rem',
    }}
  >
    {deskStatusLabel(alert)}
  </span>
);

const AlertCard = ({ alert, mode, isAdmin, busy, onTake, onRelease, onAddress, now }) => {
  const overdue = mode === 'waiting' && isOverdue(alert, now);
  const tel = telLink(alert.reporter_phone);
  const link = mapLink(alert.latitude, alert.longitude);
  const border = mode === 'waiting' ? (overdue ? '#CC2229' : '#F5A623') : 'var(--border)';

  return (
    <div
      data-testid={`desk-alert-${alert.id}`}
      style={{
        background: 'var(--bg-card)', border: `2px solid ${border}`, borderRadius: 'var(--radius)',
        padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.55rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          <strong style={{ fontSize: '1.05rem' }}>{typeLabel(alert.type)}</strong>
          <StatusChip alert={alert} />
        </span>
        <span style={{ fontSize: '0.82rem', fontWeight: 700, color: overdue ? '#CC2229' : 'var(--text-muted)' }}>
          {overdue ? 'Pending ' : 'Raised '}{formatAgo(alert.created_at, now)}
        </span>
      </div>

      <div style={{ fontSize: '0.9rem' }}>
        <div><strong>{reporterLabel(alert.reporter_name)}</strong></div>
        {tel ? (
          <a href={tel} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700 }}>
            <MdPhone /> {alert.reporter_phone}
          </a>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>No phone number on the account</span>
        )}
      </div>

      {alert.description ? (
        <p style={{ fontSize: '0.88rem', background: 'var(--bg-input)', borderRadius: 6, padding: '0.5rem 0.65rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {alert.description}
        </p>
      ) : null}

      <div style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'monospace' }}>{formatCoordinates(alert.latitude, alert.longitude)}</span>
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <MdMap /> Open map
          </a>
        ) : null}
      </div>

      {mode !== 'waiting' ? (
        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          {mode === 'mine' ? 'Acknowledged by you' : `Acknowledged by ${alert.acknowledged_by_name}`}
          {alert.acknowledged_at ? ` - ${formatAgo(alert.acknowledged_at, now)}` : ''}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.2rem' }}>
        {mode === 'waiting' ? (
          <Button size="sm" variant="danger" loading={busy} onClick={() => onTake(alert)}>
            <MdPanTool /> Acknowledge (take it)
          </Button>
        ) : null}
        {mode === 'mine' || (mode === 'others' && isAdmin) ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRelease(alert)}>
            <MdUndo /> Return to queue
          </Button>
        ) : null}
        {canMarkAddressed(alert, mode, isAdmin) ? (
          <Button size="sm" variant="success" disabled={busy} onClick={() => onAddress(alert)}>
            <MdCheckCircle /> Mark Addressed
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const Section = ({ title, color, alerts, empty, ...cardProps }) => (
  <section>
    <h3 style={{ ...sectionTitle, color }}>{title} ({alerts.length})</h3>
    {alerts.length === 0 ? (
      <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>{empty}</p>
    ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.85rem' }}>
        {alerts.map((a) => (
          <AlertCard key={a.id} alert={a} busy={cardProps.busyId === a.id} {...cardProps} />
        ))}
      </div>
    )}
  </section>
);

const EmergencyDesk = () => {
  const { user, isAdmin } = useAuth();
  const [soundOn, setSoundOn] = useState(readSoundPref);
  const [busyId, setBusyId] = useState(null);
  const [confirmAddress, setConfirmAddress] = useState(null);
  const [now, setNow] = useState(Date.now());
  const previousWaiting = useRef(null);

  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ['desk-alerts'],
    queryFn: () => listEmergencies({ status: 'active', limit: 200 }),
    select: (res) => res.data.data.alerts,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
    retry: (count, err) => err?.response?.status !== 403 && count < 2,
  });

  const groups = useMemo(() => groupAlerts(data, user?.id), [data, user?.id]);

  // Ticks the "waiting" clocks between refreshes.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setNow(Date.now());
    if (!data) return;
    const fresh = newlyWaiting(previousWaiting.current, groups.waiting);
    previousWaiting.current = groups.waiting.map((a) => a.id);
    if (fresh.length > 0) {
      if (soundOn) playAlertTone();
      toast.error(fresh.length === 1 ? 'New emergency pending' : `${fresh.length} new emergencies pending`, { duration: 6000 });
    }
  }, [dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const previous = document.title;
    document.title = pageTitle(groups.waiting.length);
    return () => { document.title = previous; };
  }, [groups.waiting.length]);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    try { localStorage.setItem(SOUND_KEY, next ? 'on' : 'off'); } catch { /* private window */ }
    if (next) playAlertTone();
  };

  const take = useDeskAction(acknowledgeEmergency, 'You have taken this emergency', setBusyId);
  const release = useDeskAction(releaseEmergency, 'Returned to the queue', setBusyId);
  const address = useDeskAction(addressEmergency, 'Emergency marked Addressed', setBusyId);

  const located = (data || []).filter((a) => hasLocation(a.latitude, a.longitude));
  const forbidden = isError && error?.response?.status === 403;

  const cardProps = {
    isAdmin, busyId, now,
    onTake: (a) => take.mutate(a),
    onRelease: (a) => release.mutate(a),
    onAddress: (a) => setConfirmAddress(a),
  };

  return (
    <Layout>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <MdSos size={28} color="#CC2229" /> Emergency Desk
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
            Acknowledge an emergency (take it) before calling, so no two operators answer the same SOS. Mark it Addressed
            once the desk has dealt with it. Refreshes every {REFRESH_MS / 1000} seconds.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={toggleSound}>
          {soundOn ? <MdVolumeUp /> : <MdVolumeOff />} {soundOn ? 'Sound on' : 'Sound off'}
        </Button>
      </div>

      <div role="note" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', background: '#FFF7E6', border: '1px solid #F5A62366', borderRadius: 'var(--radius)', padding: '0.75rem 1rem', fontSize: '0.85rem', marginBottom: '1rem' }}>
        <MdInfoOutline size={20} color="#B7791F" style={{ flexShrink: 0 }} />
        <span>
          The CaribWayz desk is not a replacement for police, fire or ambulance. If a caller is in immediate danger,
          tell them to call their local emergency number (in Jamaica: 119 police, 110 fire and ambulance) while you arrange help.
        </span>
      </div>

      {isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading the queue...</p>
      ) : forbidden ? (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.5rem' }}>
          <h3 style={{ fontWeight: 700, marginBottom: '0.4rem' }}>No desk access</h3>
          <p style={{ color: 'var(--text-muted)' }}>
            Your account cannot see live emergencies. Ask an administrator to give you responder access in Manage Users.
          </p>
        </div>
      ) : isError ? (
        <div style={{ background: '#FDECEC', border: '1px solid #CC222944', borderRadius: 'var(--radius)', padding: '1rem' }}>
          <strong>The queue could not be loaded.</strong> {errorMessage(error, 'Please try again.')} It will retry automatically.
        </div>
      ) : (
        <>
          {located.length > 0 ? (
            <div style={{ height: 300, borderRadius: 'var(--radius)', overflow: 'hidden', border: '1px solid var(--border)' }}>
              <MapContainer
                key={located.map((a) => a.id).join(',')}
                bounds={located.length > 1 ? located.map((a) => [Number(a.latitude), Number(a.longitude)]) : undefined}
                center={located.length === 1 ? [Number(located[0].latitude), Number(located[0].longitude)] : DEFAULT_CENTER}
                zoom={located.length === 1 ? 14 : 9}
                boundsOptions={{ padding: [50, 50], maxZoom: 15 }}
                style={{ height: '100%', width: '100%' }}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {located.map((a) => (
                  <CircleMarker
                    key={a.id}
                    center={[Number(a.latitude), Number(a.longitude)]}
                    radius={10}
                    pathOptions={{ color: deskStatusOf(a) === 'acknowledged' ? '#2D8C00' : '#CC2229', fillOpacity: 0.7 }}
                  >
                    <Popup>
                      <strong>{typeLabel(a.type)}</strong><br />
                      {reporterLabel(a.reporter_name)}<br />
                      {deskStatusOf(a) === 'acknowledged' ? `Acknowledged by ${a.acknowledged_by_name}` : 'Pending'}
                    </Popup>
                  </CircleMarker>
                ))}
              </MapContainer>
            </div>
          ) : null}

          <Section title="Pending" color="#CC2229" alerts={groups.waiting} mode="waiting"
            empty="No emergency is pending." {...cardProps} />
          <Section title="Acknowledged by you" color="#2D8C00" alerts={groups.mine} mode="mine"
            empty="You have not acknowledged an emergency." {...cardProps} />
          <Section title="Acknowledged by other operators" color="var(--text-muted)" alerts={groups.others} mode="others"
            empty="No other operator has acknowledged an emergency." {...cardProps} />
        </>
      )}

      {confirmAddress ? (
        <Modal title="Mark this emergency Addressed?" onClose={() => setConfirmAddress(null)}>
          <p style={{ marginBottom: '0.75rem' }}>
            {typeLabel(confirmAddress.type)} for {reporterLabel(confirmAddress.reporter_name)}. Addressed means the desk
            has dealt with this alert in CaribWayz. It does not say that help has arrived or that the emergency is over,
            and the person and their trusted contacts are told exactly that.
          </p>
          <p style={{ marginBottom: '1rem' }}>
            It leaves the queue for every operator and cannot be undone.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setConfirmAddress(null)}>Keep it open</Button>
            <Button
              variant="success"
              onClick={() => { address.mutate(confirmAddress); setConfirmAddress(null); }}
            >
              <MdCheckCircle /> Mark Addressed
            </Button>
          </div>
        </Modal>
      ) : null}
    </Layout>
  );
};

export default EmergencyDesk;
