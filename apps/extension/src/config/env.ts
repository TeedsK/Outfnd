/**
 * Centralized access to Vite env vars (type-safe).
 */
const v = import.meta.env;

export const aiLogicUrl = (v.VITE_AI_LOGIC_URL ?? "").trim();
export const isAiLogicConfigured = aiLogicUrl.length > 0;

export const firebaseEnv = {
  apiKey: (v.VITE_FIREBASE_API_KEY ?? "").trim(),
  authDomain: (v.VITE_FIREBASE_AUTH_DOMAIN ?? "").trim(),
  projectId: (v.VITE_FIREBASE_PROJECT_ID ?? "").trim(),
  appId: (v.VITE_FIREBASE_APP_ID ?? "").trim(),
  storageBucket: (v.VITE_FIREBASE_STORAGE_BUCKET ?? "").trim(),
  messagingSenderId: (v.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "").trim(),
  measurementId: (v.VITE_FIREBASE_MEASUREMENT_ID ?? "").trim()
};
