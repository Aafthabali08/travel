import { initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  type Auth,
  type User,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import { log } from "./api";

// Must match the admin email in firestore.rules; the rules are what actually grant access.
export const ADMIN_EMAIL = "aafthabali08@gmail.com";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
};
export const firebaseReady = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId,
);
export let auth: Auth | null = null;
export let db: Firestore | null = null;
if (firebaseReady) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  // Automated tests run against the local Firebase emulators, never the real project.
  if (import.meta.env.VITE_FIREBASE_EMULATORS === "1") {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
} else {
  log(
    "auth.not_configured",
    "Set VITE_FIREBASE_* in .env to enable sign-in",
    "WARN",
  );
}

export const isAdminEmail = (user: User | null) =>
  user?.email?.toLowerCase() === ADMIN_EMAIL;
export const isAdmin = (user: User | null) =>
  isAdminEmail(user) && Boolean(user?.emailVerified);
