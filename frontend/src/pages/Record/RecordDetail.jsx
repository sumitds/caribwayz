import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getRecordById } from '../../api/records';
import Layout from '../../components/Layout/Layout';
import { MdArrowBack, MdLocationOn, MdCalendarToday, MdPerson, MdDirectionsCar, MdPolicy, MdPeople } from 'react-icons/md';
import { format } from 'date-fns';

const severityMeta = {
  minor: { color: '#2D8C00', bg: '#2D8C0018' },
  major: { color: '#F5A623', bg: '#F5A62318' },
  fatal: { color: '#CC2229', bg: '#CC222918' },
};

const Section = ({ title, icon: Icon, children }) => (
  <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.1rem 1.3rem', marginBottom: '0.75rem' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.85rem', paddingBottom: '0.6rem', borderBottom: '1px solid var(--border)' }}>
      <Icon size={16} color="#F5A623" />
      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</span>
    </div>
    {children}
  </div>
);

const Row = ({ label, value }) => value ? (
  <div style={{ marginBottom: '0.6rem' }}>
    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>{label}</div>
    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{value}</div>
  </div>
) : null;

const RecordDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  const { data: record, isLoading } = useQuery({
    queryKey: ['record', id],
    queryFn: () => getRecordById(id),
    select: (res) => res.data.data.record,
  });

  if (isLoading) return (
    <Layout>
      <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>Loading record...</div>
    </Layout>
  );

  if (!record) return (
    <Layout>
      <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>Record not found.</div>
    </Layout>
  );

  const meta = severityMeta[record.severity] || severityMeta.minor;
  const hasOtherParty = record.other_party_name || record.other_party_contact || record.other_party_vehicle;

  return (
    <Layout>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {/* Back */}
        <button onClick={() => navigate('/record')} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.4rem', padding: 0 }}>
          <MdArrowBack size={18} /> Back to Records
        </button>

        {/* Incident header card */}
        <div style={{ background: 'var(--bg-card)', border: `1px solid ${meta.color}55`, borderRadius: 'var(--radius)', padding: '1.3rem 1.5rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.85rem' }}>
            <span style={{
              fontSize: '0.75rem', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase',
              color: meta.color, background: meta.bg, padding: '0.25rem 0.7rem',
              borderRadius: 20, border: `1px solid ${meta.color}55`,
            }}>
              {record.severity}
            </span>
            <span style={{ fontSize: '0.78rem', fontFamily: 'monospace', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
              {record.incident_id}
            </span>
          </div>

          <div style={{ fontSize: '1.1rem', fontWeight: 800, textTransform: 'capitalize', marginBottom: '0.3rem' }}>
            {record.type.replace(/_/g, ' ')}
          </div>
          {record.parish && (
            <div style={{ fontSize: '0.83rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <MdLocationOn size={14} /> {record.parish}
            </div>
          )}

          {/* Timestamps */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>Event Logged</div>
              <div style={{ fontSize: '0.83rem', fontWeight: 700 }}>
                {format(new Date(record.created_at), 'dd MMM yyyy · h:mm a')}
              </div>
            </div>
            {record.occurred_at && (
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>Event Occurred</div>
                <div style={{ fontSize: '0.83rem', fontWeight: 700 }}>
                  {format(new Date(record.occurred_at), 'dd MMM yyyy · h:mm a')}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Description + Location + Cause */}
        <Section title="Incident Details" icon={MdCalendarToday}>
          <Row label="Description" value={record.description} />
          <Row label="Location" value={record.location_text} />
          <Row label="Cause" value={record.cause} />
        </Section>

        {/* Police */}
        {record.police_report_number && (
          <Section title="Police Report" icon={MdPolicy}>
            <Row label="Report Number" value={record.police_report_number} />
          </Section>
        )}

        {/* Other party */}
        {hasOtherParty && (
          <Section title="Other Party" icon={MdPerson}>
            <Row label="Name" value={record.other_party_name} />
            <Row label="Contact" value={record.other_party_contact} />
            <Row label="Vehicle Plate" value={record.other_party_vehicle} />
          </Section>
        )}

        {/* Witnesses */}
        {record.witness_info && (
          <Section title="Witnesses" icon={MdPeople}>
            <p style={{ fontSize: '0.88rem', lineHeight: 1.5, color: 'var(--text)' }}>{record.witness_info}</p>
          </Section>
        )}

        {/* Insurance/legal note */}
        <div style={{ background: '#F5A62310', border: '1px solid #F5A62333', borderRadius: 'var(--radius)', padding: '0.85rem 1.1rem', marginTop: '0.5rem' }}>
          <p style={{ fontSize: '0.78rem', color: '#F5A623', lineHeight: 1.5 }}>
            <strong>For official use:</strong> This record ({record.incident_id}) was logged via CaribWayz on {format(new Date(record.created_at), 'dd MMMM yyyy')}. Present this document alongside your insurance claim or police report.
          </p>
        </div>
      </div>
    </Layout>
  );
};

export default RecordDetail;
