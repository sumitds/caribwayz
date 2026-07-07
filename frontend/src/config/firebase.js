import { initializeApp, getApps } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getMessaging, isSupported } from 'firebase/messaging';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Only initialize if config values are present
const isConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'your_firebase_web_api_key';

let app = null;
let database = null;
let messaging = null;

if (isConfigured) {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  database = getDatabase(app);

  // FCM only works in browsers that support it (not Safari < 16)
  isSupported().then((supported) => {
    if (supported) {
      messaging = getMessaging(app);
    }
  });
} else {
  console.warn('[Firebase Client] Not configured — Realtime DB and push notifications disabled.');
}

export { app, database, messaging, isConfigured };
