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
  getDoc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
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

function membersDoc(familyCode, uid) {
  return doc(db, "spaces", familyCode, "members", uid);
}

function invitesDoc(familyCode, inviteCode) {
  return doc(db, "spaces", familyCode, "invites", inviteCode);
}

function accessDoc(familyCode) {
  return doc(db, "spaces", familyCode, "meta", "access");
}

export async function isFamilyMember(familyCode, uid) {
  const memberSnap = await getDoc(membersDoc(familyCode, uid));
  return memberSnap.exists();
}

export async function createInvite(familyCode, user, inviteCode, maxUses = 1, ttlHours = 72) {
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const ref = invitesDoc(familyCode, inviteCode);

  await setDoc(ref, {
    createdAt: serverTimestamp(),
    createdBy: {
      uid: user.uid,
      email: user.email || null,
      name: user.displayName || null,
    },
    expiresAt,
    maxUses,
    usedCount: 0,
    usedBy: null,
    usedAt: null,
  });

  return { inviteCode, expiresAt };
}

export async function bootstrapSpaceOwner(familyCode, user) {
  await runTransaction(db, async (transaction) => {
    const memberRef = membersDoc(familyCode, user.uid);
    const ownerRef = accessDoc(familyCode);

    const [memberSnap, ownerSnap] = await Promise.all([transaction.get(memberRef), transaction.get(ownerRef)]);

    if (!ownerSnap.exists()) {
      transaction.set(ownerRef, {
        ownerUid: user.uid,
        createdAt: serverTimestamp(),
      });
    }

    if (!memberSnap.exists()) {
      transaction.set(memberRef, {
        uid: user.uid,
        email: user.email || null,
        name: user.displayName || null,
        inviteCode: "OWNER_BOOTSTRAP",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  });
}

export async function consumeInviteAndJoinFamily(familyCode, inviteCode, user) {
  await runTransaction(db, async (transaction) => {
    const memberRef = membersDoc(familyCode, user.uid);
    const inviteRef = invitesDoc(familyCode, inviteCode);

    const [memberSnap, inviteSnap] = await Promise.all([
      transaction.get(memberRef),
      transaction.get(inviteRef),
    ]);

    if (memberSnap.exists()) {
      transaction.update(memberRef, {
        email: user.email || null,
        name: user.displayName || null,
        updatedAt: serverTimestamp(),
      });
      return;
    }

    if (!inviteSnap.exists()) {
      throw new Error("INVITE_NOT_FOUND");
    }

    const invite = inviteSnap.data();
    const expiresAtMs = invite.expiresAt?.toMillis?.() ?? null;
    if (!expiresAtMs || expiresAtMs <= Date.now()) {
      throw new Error("INVITE_EXPIRED");
    }

    const maxUses = Number(invite.maxUses || 1);
    const usedCount = Number(invite.usedCount || 0);
    if (usedCount >= maxUses) {
      throw new Error("INVITE_LIMIT");
    }

    transaction.set(memberRef, {
      uid: user.uid,
      email: user.email || null,
      name: user.displayName || null,
      inviteCode,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    transaction.update(inviteRef, {
      usedCount: usedCount + 1,
      usedBy: user.uid,
      usedAt: serverTimestamp(),
    });
  });
}

export async function touchMembership(familyCode, user) {
  await updateDoc(membersDoc(familyCode, user.uid), {
    email: user.email || null,
    name: user.displayName || null,
    updatedAt: serverTimestamp(),
  });
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
