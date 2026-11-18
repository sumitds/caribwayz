const admin = require('firebase-admin');

let initialized = false;
// firebase-admin throws ("Can't determine Firebase Database URL." / "Bucket
// name not specified") when these services are asked for without their URL or
// bucket, so they count as configured only when the variable is set.
let hasDatabaseUrl = false;
let hasStorageBucket = false;

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
    console.warn('[Firebase] Credentials not set — Realtime DB, FCM, Storage and social/phone sign-in are disabled.');
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
    hasDatabaseUrl = Boolean(FIREBASE_DATABASE_URL);
    hasStorageBucket = Boolean(FIREBASE_STORAGE_BUCKET);
    console.log('[Firebase] Initialized successfully');
    return true;
  } catch (err) {
    console.error('[Firebase] Initialization failed:', err.message);
    return false;
  }
};

/** Realtime Database, or null when Firebase or FIREBASE_DATABASE_URL is not set. */
const getRealtimeDB = () => {
  if (!initialized || !hasDatabaseUrl) return null;
  return admin.database();
};

const getMessaging = () => {
  if (!initialized) return null;
  return admin.messaging();
};

/** Firebase Auth, for verifying ID tokens from the app. Null when not initialised. */
const getAuth = () => {
  if (!initialized) return null;
  return admin.auth();
};

/** Storage bucket, or null when Firebase or FIREBASE_STORAGE_BUCKET is not set. */
const getStorage = () => {
  if (!initialized || !hasStorageBucket) return null;
  return admin.storage().bucket();
};

module.exports = { initFirebase, getRealtimeDB, getMessaging, getAuth, getStorage };
