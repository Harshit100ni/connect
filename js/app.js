import {
  ICE_SERVERS,
  getLocalStream,
  createPeerConnection,
  startQualityMonitor,
} from './webrtc.js';
import { setupAudioMonitor } from './audio.js';
import { createRoom, joinRoom, cleanupRoom } from './signaling.js';

// — State —
let pc = null;
let localStream = null;
let isMuted = false;
let callStartTime = null;
let timerInterval = null;
let remoteAudio = null;
let stopLocalMonitor = null;
let stopRemoteMonitor = null;
let stopQuality = null;
let roomId = null;

// — DOM helpers —
const $ = (id) => document.getElementById(id);

function showView(viewId) {
  ['setupView', 'waitingView', 'joiningView'].forEach(id => {
    $(id).classList.toggle('hidden', id !== viewId);
  });
  $('callView').classList.toggle('active', viewId === 'callView');
}

function getUserName() {
  return $('userName').value.trim() || 'You';
}

function updateQuality(quality) {
  const el = $('qualityIndicator');
  el.className = `quality-indicator ${quality}`;
  const label = {
    good: 'Good connection',
    fair: 'Fair connection',
    poor: 'Poor connection',
    reconnecting: 'Reconnecting…',
  }[quality];
  el.innerHTML = `<span class="dot"></span>${label}`;
}

// — WebRTC setup —
function initPeerConnection() {
  pc = createPeerConnection(ICE_SERVERS, {
    onConnected: showCallView,
    onDisconnected: endCall,
    onReconnecting: () => updateQuality('reconnecting'),
    onRemoteTrack(stream) {
      if (!remoteAudio) {
        remoteAudio = new Audio();
        remoteAudio.autoplay = true;
        remoteAudio.style.display = 'none';
        document.body.appendChild(remoteAudio);
      }
      if (remoteAudio.srcObject !== stream) {
        remoteAudio.srcObject = stream;
        remoteAudio.play().catch(() => $('autoplayBtn').classList.remove('hidden'));
        stopRemoteMonitor?.();
        stopRemoteMonitor = setupAudioMonitor(stream, 'remoteAvatar');
      }
    },
  });

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    stopLocalMonitor?.();
    stopLocalMonitor = setupAudioMonitor(localStream, 'localAvatar');
  }
}

async function acquireMic() {
  try {
    localStream = await getLocalStream();
    return true;
  } catch {
    alert('Microphone access is required. Please allow it and try again.');
    return false;
  }
}

// — Caller flow —
async function startCall() {
  $('startCallBtn').disabled = true;
  if (!(await acquireMic())) { $('startCallBtn').disabled = false; return; }

  $('localInitial').textContent = getUserName().charAt(0).toUpperCase();
  initPeerConnection();
  showView('waitingView');

  try {
    roomId = await createRoom(pc);
    const url = `${location.origin}${location.pathname}?room=${roomId}`;
    $('shareUrl').value = url;
    history.replaceState(null, '', `?room=${roomId}`);
  } catch {
    endCall();
    alert('Failed to create call. Check your Firebase configuration and try again.');
  }

  $('startCallBtn').disabled = false;
}

// — Receiver flow —
async function joinCall(rid) {
  showView('joiningView');
  if (!(await acquireMic())) {
    history.replaceState(null, '', location.pathname);
    showView('setupView');
    return;
  }

  $('localInitial').textContent = getUserName().charAt(0).toUpperCase();
  initPeerConnection();

  try {
    const joined = await joinRoom(pc, rid);
    if (!joined) {
      alert('Room not found. The link may have expired or already been used.');
      endCall();
    }
    // onConnected fires automatically when ICE connects → showCallView()
  } catch {
    alert('Failed to join call. Please try again.');
    endCall();
  }
}

// — Call view —
function showCallView() {
  if (callStartTime !== null) {
    // Reconnected after a drop — restore quality display.
    updateQuality('good');
    return;
  }

  showView('callView');

  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    $('callTimer').textContent = `${mm}:${ss}`;
  }, 1000);

  stopQuality = startQualityMonitor(pc, updateQuality);
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
  $('muteBtn').classList.toggle('muted', isMuted);
  $('micIcon').classList.toggle('hidden', isMuted);
  $('micOffIcon').classList.toggle('hidden', !isMuted);
}

function endCall() {
  cleanupRoom(roomId);
  roomId = null;

  pc?.close(); pc = null;
  localStream?.getTracks().forEach(t => t.stop()); localStream = null;
  clearInterval(timerInterval); timerInterval = null;
  callStartTime = null;

  stopLocalMonitor?.(); stopLocalMonitor = null;
  stopRemoteMonitor?.(); stopRemoteMonitor = null;
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); remoteAudio = null; }
  stopQuality?.(); stopQuality = null;

  $('callTimer').textContent = '00:00';
  $('qualityIndicator').className = 'quality-indicator';
  $('qualityIndicator').innerHTML = '';
  $('autoplayBtn').classList.add('hidden');
  isMuted = false;
  $('muteBtn').classList.remove('muted');
  $('micIcon').classList.remove('hidden');
  $('micOffIcon').classList.add('hidden');

  history.replaceState(null, '', location.pathname);
  showView('setupView');
}

async function copyLink(btn) {
  const url = $('shareUrl').value;
  const orig = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Copied!';
  } catch {
    $('shareUrl').select();
    $('shareUrl').setSelectionRange(0, 99999);
    btn.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => (btn.textContent = orig), 1500);
}

// — Init: auto-join if URL contains ?room= —
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  joinCall(urlRoom);
} else {
  showView('setupView');
}

// — Event listeners —
$('startCallBtn').addEventListener('click', startCall);
$('cancelWaitBtn').addEventListener('click', endCall);
$('muteBtn').addEventListener('click', toggleMute);
$('endBtn').addEventListener('click', endCall);
$('copyLinkBtn').addEventListener('click', (e) => copyLink(e.currentTarget));
$('autoplayBtn').addEventListener('click', () => {
  remoteAudio?.play();
  $('autoplayBtn').classList.add('hidden');
});
