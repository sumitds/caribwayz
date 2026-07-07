const admin = require('firebase-admin');

let initialized = false;

const initFirebase = () => {
  if (initialized) return true;

  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_DATABASE_URL,
    FIREBASE_STORAGE_BUCKET,
  } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_PRIVATE_KEY || !FIREBASE_CLIENT_EMAIL) {
    console.warn('[Firebase] Credentials not set — Realtime DB, FCM and Storage are disabled.');
    return false;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        // Render stores env vars as literal strings — replace escaped newlines
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: FIREBASE_CLIENT_EMAIL,
      }),
      databaseURL: FIREBASE_DATABASE_URL,
      storageBucket: FIREBASE_STORAGE_BUCKET,
    });

    initialized = true;
    console.log('[Firebase] Initialized successfully');
    return true;
  } catch (err) {
    console.error('[Firebase] Initialization failed:', err.message);
    return false;
  }
};

const getRealtimeDB = () => {
  if (!initialized) return null;
  return admin.database();
};

const getMessaging = () => {
  if (!initialized) return null;
  return admin.messaging();
};

const getStorage = () => {
  if (!initialized) return null;
  return admin.storage().bucket();
};

module.exports = { initFirebase, getRealtimeDB, getMessaging, getStorage };
