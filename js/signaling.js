import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getDatabase, ref, set, get, onValue, push, onChildAdded, remove,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

// ↓ Paste your Firebase project config here.
//   console.firebase.google.com → your project → Project Settings → Your apps → SDK setup
export const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBLkCTwMsSqwE_oL86KB3yED1WYF6aAipc",
    authDomain: "connect-85e8e.firebaseapp.com",
    databaseURL: "https://connect-85e8e-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "connect-85e8e",
    storageBucket: "connect-85e8e.firebasestorage.app",
    messagingSenderId: "46493181311",
    appId: "1:46493181311:web:24149770fd7734a1e5a64a",
    measurementId: "G-LMSZRNY1LQ"
  };

const app = initializeApp(FIREBASE_CONFIG);
const db  = getDatabase(app);
const r   = (path) => ref(db, path);

function genId() {
  return Math.random().toString(36).slice(2, 9);
}

// Caller: creates a room, writes the offer, returns the room ID.
// ICE candidates are sent to Firebase as they arrive (trickle ICE).
export async function createRoom(pc) {
  const roomId = genId();

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) push(r(`rooms/${roomId}/callerCandidates`), candidate.toJSON());
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await set(r(`rooms/${roomId}/offer`), { type: offer.type, sdp: offer.sdp });

  // Listen for the receiver's answer.
  onValue(r(`rooms/${roomId}/answer`), async (snap) => {
    if (snap.exists() && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
    }
  });

  // Add receiver's ICE candidates as they arrive.
  onChildAdded(r(`rooms/${roomId}/receiverCandidates`), (snap) => {
    pc.addIceCandidate(new RTCIceCandidate(snap.val())).catch(() => {});
  });

  return roomId;
}

// Receiver: joins an existing room. Returns false if the room doesn't exist.
export async function joinRoom(pc, roomId) {
  const offerSnap = await get(r(`rooms/${roomId}/offer`));
  if (!offerSnap.exists()) return false;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) push(r(`rooms/${roomId}/receiverCandidates`), candidate.toJSON());
  };

  // Add caller's ICE candidates as they arrive.
  onChildAdded(r(`rooms/${roomId}/callerCandidates`), (snap) => {
    pc.addIceCandidate(new RTCIceCandidate(snap.val())).catch(() => {});
  });

  await pc.setRemoteDescription(new RTCSessionDescription(offerSnap.val()));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await set(r(`rooms/${roomId}/answer`), { type: answer.type, sdp: answer.sdp });

  return true;
}

// Delete room data from Firebase when the call ends.
export async function cleanupRoom(roomId) {
  if (roomId) await remove(r(`rooms/${roomId}`)).catch(() => {});
}
