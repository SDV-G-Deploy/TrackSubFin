import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  enableIndexedDbPersistence,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export function hasFirebaseConfig() {
  const cfg = window.TRACKSUBFIN_FIREBASE_CONFIG;
  return Boolean(cfg && cfg.apiKey && cfg.projectId && cfg.appId);
}

let app;
let auth;
let db;

export function initFirebase() {
  if (!hasFirebaseConfig()) {
    throw new Error("Firebase config отсутствует");
  }

  if (app) return { app, auth, db };

  app = initializeApp(window.TRACKSUBFIN_FIREBASE_CONFIG);
  auth = getAuth(app);
  db = getFirestore(app);

  enableIndexedDbPersistence(db).catch(() => {
    // Не критично: realtime все равно работает.
  });

  return { app, auth, db };
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export async function logout() {
  return signOut(auth);
}

function subscriptionsCollection(familyCode) {
  return collection(db, "spaces", familyCode, "subscriptions");
}

export async function ensureFamilyMembership(familyCode, user) {
  const memberRef = doc(db, "spaces", familyCode, "members", user.uid);
  await setDoc(
    memberRef,
    {
      uid: user.uid,
      email: user.email || null,
      name: user.displayName || null,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export function watchSubscriptions(familyCode, callback, onError) {
  const q = query(subscriptionsCollection(familyCode), orderBy("nextChargeDate", "asc"));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
      callback(items);
    },
    onError
  );
}

export async function createSubscription(familyCode, payload, user) {
  const col = subscriptionsCollection(familyCode);
  await addDoc(col, {
    ...payload,
    createdAt: serverTimestamp(),
    createdBy: {
      uid: user.uid,
      email: user.email || null,
      name: user.displayName || null,
    },
  });
}

export async function removeSubscription(familyCode, subscriptionId) {
  await deleteDoc(doc(db, "spaces", familyCode, "subscriptions", subscriptionId));
}
