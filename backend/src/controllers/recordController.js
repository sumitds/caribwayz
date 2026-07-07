const { query } = require('../config/db');
const { success, created, error, notFound } = require('../utils/response');

const generateIncidentId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'INC-';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

const ensureTable = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS incident_records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      incident_id VARCHAR(20) UNIQUE NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'minor',
      type VARCHAR(50) NOT NULL DEFAULT 'accident',
      description TEXT,
      location_text VARCHAR(255),
      cause VARCHAR(255),
      parish VARCHAR(100),
      occurred_at TIMESTAMP,
      police_report_number VARCHAR(100),
      other_party_name VARCHAR(255),
      other_party_contact VARCHAR(100),
      other_party_vehicle VARCHAR(100),
      witness_info TEXT,
      image_count INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'submitted',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
};

const getMyRecords = async (req, res) => {
  try {
    await ensureTable();
    const { severity, type, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT * FROM incident_records WHERE user_id = $1`;
    const params = [req.user.id];

    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    if (type && type !== 'all') { params.push(type); sql += ` AND type = $${params.length}`; }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) FROM incident_records WHERE user_id = $1', [req.user.id]);

    return success(res, { records: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error('Get records error:', err);
    return error(res, 'Failed to fetch records', 500);
  }
};

const getRecordById = async (req, res) => {
  try {
    await ensureTable();
    const result = await query(
      `SELECT * FROM incident_records WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return notFound(res, 'Record not found');
    return success(res, { record: result.rows[0] });
  } catch (err) {
    console.error('Get record error:', err);
    return error(res, 'Failed to fetch record', 500);
  }
};

const createRecord = async (req, res) => {
  try {
    await ensureTable();
    const {
      severity, type, description, location_text, cause, parish,
      occurred_at, police_report_number, other_party_name,
      other_party_contact, other_party_vehicle, witness_info,
    } = req.body;

    const incidentId = generateIncidentId();

    const result = await query(
      `INSERT INTO incident_records
        (user_id, incident_id, severity, type, description, location_text, cause, parish,
         occurred_at, police_report_number, other_party_name, other_party_contact,
         other_party_vehicle, witness_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        req.user.id, incidentId, severity || 'minor', type || 'accident',
        description, location_text, cause, parish,
        occurred_at || null, police_report_number,
        other_party_name, other_party_contact, other_party_vehicle, witness_info,
      ]
    );

    return created(res, { record: result.rows[0] }, 'Incident record created');
  } catch (err) {
    console.error('Create record error:', err);
    return error(res, 'Failed to create record', 500);
  }
};

const deleteRecord = async (req, res) => {
  try {
    await ensureTable();
    const result = await query(
      `DELETE FROM incident_records WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return notFound(res, 'Record not found');
    return success(res, {}, 'Record deleted');
  } catch (err) {
    console.error('Delete record error:', err);
    return error(res, 'Failed to delete record', 500);
  }
};

// Admin: see all records
const getAllRecords = async (req, res) => {
  try {
    await ensureTable();
    const { severity, type, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT r.*, u.name as reporter_name, u.email as reporter_email
               FROM incident_records r JOIN users u ON r.user_id = u.id WHERE 1=1`;
    const params = [];

    if (severity) { params.push(severity); sql += ` AND r.severity = $${params.length}`; }
    if (type && type !== 'all') { params.push(type); sql += ` AND r.type = $${params.length}`; }

    sql += ` ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) FROM incident_records');

    return success(res, { records: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error('Admin get records error:', err);
    return error(res, 'Failed to fetch records', 500);
  }
};

module.exports = { getMyRecords, getRecordById, createRecord, deleteRecord, getAllRecords };
