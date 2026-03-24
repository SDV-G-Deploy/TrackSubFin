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
  increment,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
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

function toAppError(error, fallback = "UNKNOWN") {
  const err = new Error(fallback);
  err.code = error?.code || null;
  err.cause = error || null;
  return err;
}

function isFirestoreCode(error, code) {
  return error?.code === code;
}

export async function bootstrapSpaceOwner(familyCode, user) {
  const memberRef = membersDoc(familyCode, user.uid);
  const ownerRef = accessDoc(familyCode);

  try {
    await updateDoc(memberRef, {
      email: user.email || null,
      name: user.displayName || null,
      updatedAt: serverTimestamp(),
    });
    return;
  } catch (error) {
    if (!isFirestoreCode(error, "not-found") && !isFirestoreCode(error, "permission-denied")) {
      throw toAppError(error, "BOOTSTRAP_MEMBER_UPDATE_FAILED");
    }
  }

  try {
    await setDoc(ownerRef, {
      ownerUid: user.uid,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    if (!isFirestoreCode(error, "permission-denied") && !isFirestoreCode(error, "already-exists")) {
      throw toAppError(error, "BOOTSTRAP_OWNER_CREATE_FAILED");
    }
  }

  try {
    await setDoc(memberRef, {
      uid: user.uid,
      email: user.email || null,
      name: user.displayName || null,
      inviteCode: "OWNER_BOOTSTRAP",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isFirestoreCode(error, "permission-denied") || isFirestoreCode(error, "failed-precondition")) {
      throw toAppError(error, "BOOTSTRAP_NOT_ALLOWED");
    }
    throw toAppError(error, "BOOTSTRAP_MEMBER_CREATE_FAILED");
  }
}

export async function consumeInviteAndJoinFamily(familyCode, inviteCode, user) {
  const memberRef = membersDoc(familyCode, user.uid);
  const inviteRef = invitesDoc(familyCode, inviteCode);

  try {
    await updateDoc(memberRef, {
      email: user.email || null,
      name: user.displayName || null,
      updatedAt: serverTimestamp(),
    });
    return;
  } catch (error) {
    if (!isFirestoreCode(error, "not-found") && !isFirestoreCode(error, "permission-denied")) {
      throw toAppError(error, "JOIN_MEMBER_UPDATE_FAILED");
    }
  }

  const inviteSnap = await getDoc(inviteRef);
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

  const batch = writeBatch(db);
  batch.set(memberRef, {
    uid: user.uid,
    email: user.email || null,
    name: user.displayName || null,
    inviteCode,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.update(inviteRef, {
    usedCount: increment(1),
    usedBy: user.uid,
    usedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    if (isFirestoreCode(error, "permission-denied") || isFirestoreCode(error, "failed-precondition")) {
      throw toAppError(error, "INVITE_RACE_OR_INVALID");
    }
    throw toAppError(error, "JOIN_COMMIT_FAILED");
  }
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
