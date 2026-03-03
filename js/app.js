import {
  ICE_SERVERS,
  getLocalStream,
  createPeerConnection,
  waitForIceGathering,
  startQualityMonitor,
  encodeDescription,
  decodeDescription,
} from './webrtc.js';
import { setupAudioMonitor } from './audio.js';

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
// True from the moment processOffer starts until the receiver copies their answer.
// Ensures showCallView is never triggered before the answer code has been shared.
let receiverProcessing = false;
let pendingCallView = false;

// — DOM helpers —
const $ = (id) => document.getElementById(id);

function showSignalingView(viewId) {
  ['setupView', 'callerView', 'receiverView'].forEach(id => {
    $(id).classList.toggle('hidden', id !== viewId);
  });
}

function updateSteps(role, step) {
  const prefix = role === 'caller' ? 'c' : 'r';
  for (let i = 1; i <= 3; i++) {
    const el = $(`${prefix}Step${i}`);
    el.classList.remove('active', 'done');
    if (i < step) el.classList.add('done');
    else if (i === step) el.classList.add('active');
  }
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

function setSignalingButtons(disabled) {
  ['callerBtn', 'receiverBtn', 'connectBtn', 'generateAnswerBtn'].forEach(id => {
    $(id).disabled = disabled;
  });
}

// — WebRTC setup —
function initPeerConnection() {
  pc = createPeerConnection(ICE_SERVERS, {
    onConnected() {
      if (callStartTime !== null) {
        // Reconnect after a drop — just restore quality display.
        updateQuality('good');
      } else if (receiverProcessing) {
        // ICE connected before the receiver copied their answer code.
        // Defer the call view until copyAnswerBtn is clicked.
        pendingCallView = true;
        if (!$('answerBox').classList.contains('hidden')) {
          $('receiverStatus').textContent = 'Connected! Share your answer code to complete.';
        }
      } else {
        showCallView();
      }
    },
    onDisconnected: endCall,
    onReconnecting: () => updateQuality('reconnecting'),
    onRemoteTrack(stream) {
      if (!remoteAudio) {
        remoteAudio = new Audio();
        remoteAudio.autoplay = true;
        // Attach to DOM so mobile browsers don't suspend/GC the element.
        remoteAudio.style.display = 'none';
        document.body.appendChild(remoteAudio);
      }
      if (remoteAudio.srcObject !== stream) {
        remoteAudio.srcObject = stream;
        remoteAudio.play().catch(() => {
          $('autoplayBtn').classList.remove('hidden');
        });
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
    alert('Microphone access is required for voice calls. Please allow microphone access and try again.');
    return false;
  }
}

// — Caller flow —
async function startAsCaller() {
  setSignalingButtons(true);
  if (!(await acquireMic())) { setSignalingButtons(false); return; }

  showSignalingView('callerView');
  $('localInitial').textContent = getUserName().charAt(0).toUpperCase();
  $('copyOfferBtn').disabled = true;             // Fix #9: not ready until ICE gathered
  $('callerStatus').textContent = 'Gathering network paths…'; // Fix #9: progress feedback

  try {
    initPeerConnection();
    const thisPc = pc;
    const offer = await thisPc.createOffer();
    await thisPc.setLocalDescription(offer);
    const gathered = await waitForIceGathering(thisPc);

    if (pc !== thisPc) return; // cancelled and a new call may have started
    $('offerText').value = encodeDescription(thisPc.localDescription);
    $('callerStatus').textContent = gathered
      ? 'Share your offer code below'
      : 'Share your offer code below (poor network — connection may fail)';
    $('copyOfferBtn').disabled = false;
    $('connectBtn').disabled = false;
    updateSteps('caller', 2);
  } catch {
    if (localStream !== null) {
      endCall();
      alert('Failed to create offer. Please check your microphone and try again.');
    }
  }
}

async function acceptAnswer() {
  if (!pc) return;
  $('connectBtn').disabled = true;
  const answerStr = $('answerInput').value.trim();
  if (!answerStr) {
    $('connectBtn').disabled = false;
    return alert('Please paste the answer code.');
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(decodeDescription(answerStr)));
    $('callerStatus').textContent = 'Connecting…';
    updateSteps('caller', 3);
  } catch {
    $('connectBtn').disabled = false;
    alert('Invalid answer code. Please check and try again.');
  }
}

// — Receiver flow —
async function startAsReceiver() {
  setSignalingButtons(true);
  if (!(await acquireMic())) { setSignalingButtons(false); return; }

  showSignalingView('receiverView');
  $('localInitial').textContent = getUserName().charAt(0).toUpperCase();
  $('generateAnswerBtn').disabled = false;
}

async function processOffer() {
  $('generateAnswerBtn').disabled = true;
  const offerStr = $('offerInput').value.trim();
  if (!offerStr) {
    $('generateAnswerBtn').disabled = false;
    return alert('Please paste the offer code.');
  }

  // Fix #5/#6: decode and validate first — clear error before touching WebRTC
  let decodedOffer;
  try {
    decodedOffer = decodeDescription(offerStr);
  } catch {
    $('generateAnswerBtn').disabled = false;
    return alert('Invalid offer code. Please check and try again.');
  }

  $('receiverStatus').textContent = 'Generating answer…';
  receiverProcessing = true;

  try {
    initPeerConnection();
    const thisPc = pc;
    await thisPc.setRemoteDescription(new RTCSessionDescription(decodedOffer));

    const answer = await thisPc.createAnswer();
    await thisPc.setLocalDescription(answer);
    const gathered = await waitForIceGathering(thisPc);

    if (pc !== thisPc) return; // cancelled and a new call may have started
    $('answerText').value = encodeDescription(thisPc.localDescription);
    $('answerBox').classList.remove('hidden');
    $('receiverStatus').textContent = pendingCallView
      ? 'Connected! Share your answer code to complete.'
      : gathered
        ? 'Share your answer code back'
        : 'Share your answer code back (poor network — connection may fail)';
    updateSteps('receiver', 2);
  } catch {
    if (localStream !== null) {
      receiverProcessing = false;
      pc?.close(); pc = null;
      stopLocalMonitor?.(); stopLocalMonitor = null;
      $('receiverStatus').textContent = 'Waiting for offer code…';
      $('generateAnswerBtn').disabled = false;
      alert('Connection setup failed. Please try again.');
    }
  }
}

// — Call view —
function showCallView() {
  if (callStartTime !== null) return;

  $('callerView').classList.add('hidden');
  $('receiverView').classList.add('hidden');
  $('callView').classList.add('active');

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
  pc?.close(); pc = null;
  localStream?.getTracks().forEach(t => t.stop()); localStream = null;
  clearInterval(timerInterval); timerInterval = null;
  callStartTime = null;

  stopLocalMonitor?.(); stopLocalMonitor = null;
  stopRemoteMonitor?.(); stopRemoteMonitor = null;
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); remoteAudio = null; }
  stopQuality?.(); stopQuality = null;

  $('callView').classList.remove('active');
  showSignalingView('setupView');

  ['offerText', 'answerInput', 'offerInput', 'answerText'].forEach(id => $(id).value = '');
  $('answerBox').classList.add('hidden');
  $('callTimer').textContent = '00:00';
  $('qualityIndicator').className = 'quality-indicator';
  $('qualityIndicator').innerHTML = '';
  $('autoplayBtn').classList.add('hidden');
  $('copyOfferBtn').disabled = false;
  $('callerStatus').textContent = 'Creating offer…';
  $('receiverStatus').textContent = 'Waiting for offer code…';
  isMuted = false;
  $('muteBtn').classList.remove('muted');
  $('micIcon').classList.remove('hidden');
  $('micOffIcon').classList.add('hidden');

  receiverProcessing = false;
  pendingCallView = false;
  updateSteps('caller', 1);
  updateSteps('receiver', 1);
  setSignalingButtons(false);
}

async function copyToClipboard(textareaId, btn) {
  const text = $(textareaId).value;
  const orig = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = orig), 1500);
  } catch {
    const ta = $(textareaId);
    ta.select();
    ta.setSelectionRange(0, 99999);
    btn.textContent = 'Press Ctrl+C';
    setTimeout(() => (btn.textContent = orig), 2500);
  }
}

// — Event listeners —
$('callerBtn').addEventListener('click', startAsCaller);
$('receiverBtn').addEventListener('click', startAsReceiver);
$('connectBtn').addEventListener('click', acceptAnswer);
$('generateAnswerBtn').addEventListener('click', processOffer);
$('muteBtn').addEventListener('click', toggleMute);
$('endBtn').addEventListener('click', endCall);
$('copyOfferBtn').addEventListener('click', (e) => copyToClipboard('offerText', e.currentTarget));
$('copyAnswerBtn').addEventListener('click', (e) => {
  copyToClipboard('answerText', e.currentTarget);
  receiverProcessing = false;
  if (pendingCallView) { pendingCallView = false; showCallView(); }
});
$('autoplayBtn').addEventListener('click', () => {
  remoteAudio?.play();
  $('autoplayBtn').classList.add('hidden');
});
// Fix #7: cancel/back buttons — endCall handles full cleanup and returns to setup
$('callerCancelBtn').addEventListener('click', endCall);
$('receiverCancelBtn').addEventListener('click', endCall);
