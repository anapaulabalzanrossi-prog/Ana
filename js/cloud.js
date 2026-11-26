// Sincronização via Firebase (login Google + Firestore com cache offline)
const V = '10.12.2';
const base = `https://www.gstatic.com/firebasejs/${V}`;

let auth, fs, A, F, user = null;
const unsubs = [];

export async function init(config, { onUser }) {
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  A = authMod; F = fsMod;
  const app = initializeApp(config);
  auth = A.getAuth(app);
  auth.languageCode = 'pt';
  try {
    fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    fs = F.getFirestore(app);
  }
  A.getRedirectResult(auth).catch((e) => console.warn(e));
  A.onAuthStateChanged(auth, (u) => {
    unsubs.splice(0).forEach((f) => f());
    user = u ? { uid: u.uid, name: u.displayName, email: u.email, photo: u.photoURL } : null;
    onUser(user);
  });
}

export async function signIn() {
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await A.signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) {
      await A.signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user') {
      throw e;
    }
  }
}

export const signOut = () => A.signOut(auth);

const colRef = (col) => F.collection(fs, 'users', user.uid, col);
const clean = (o) => JSON.parse(JSON.stringify(o)); // remove undefined

export const put = (col, doc) => F.setDoc(F.doc(colRef(col), doc.id), clean(doc));
export const remove = (col, id) => F.deleteDoc(F.doc(colRef(col), id));

export async function bulkPut(data) {
  let batch = F.writeBatch(fs), n = 0;
  for (const [col, docs] of Object.entries(data)) {
    if (!Array.isArray(docs)) continue;
    for (const d of docs) {
      batch.set(F.doc(colRef(col), d.id), clean(d), col === 'meta' ? { merge: true } : undefined);
      if (++n % 400 === 0) { await batch.commit(); batch = F.writeBatch(fs); }
    }
  }
  await batch.commit();
}

export function listen(cols, onChanges) {
  for (const col of cols) {
    unsubs.push(F.onSnapshot(colRef(col), { includeMetadataChanges: true }, (snap) => {
      onChanges(col, snap.docChanges().map((c) => ({ type: c.type, id: c.doc.id, data: c.doc.data() })), !snap.metadata.fromCache);
    }, (e) => console.error('Snapshot', col, e)));
  }
}
