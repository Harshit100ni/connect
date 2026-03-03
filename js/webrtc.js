export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export async function getLocalStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
    },
    video: false,
  });
}

export function createPeerConnection(iceServers, { onConnected, onDisconnected, onReconnecting, onRemoteTrack }) {
  const pc = new RTCPeerConnection({ iceServers });
  let disconnectTimer = null;

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
      onConnected?.();
    } else if (s === 'disconnected') {
      // Let WebRTC try to recover on its own; only give up after 15s.
      // A 5-second wifi blip should not end the call.
      onReconnecting?.();
      disconnectTimer = setTimeout(() => {
        if (pc.iceConnectionState !== 'closed') onDisconnected?.();
      }, 15000);
    } else if (s === 'failed') {
      clearTimeout(disconnectTimer);
      onDisconnected?.();
    }
  };

  if (onRemoteTrack) {
    pc.ontrack = (e) => { if (e.streams.length > 0) onRemoteTrack(e.streams[0]); };
  }

  return pc;
}

// Resolves true when gathering finishes, false if the timeout fires first.
export function waitForIceGathering(pc, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve(true);
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve(true);
      }
    };
  });
}

export function startQualityMonitor(pc, onUpdate) {
  let prev = {};

  onUpdate('good'); // show immediately; interval updates every 5s

  const id = setInterval(async () => {
    // Fix #9: skip if the connection has already been closed
    if (pc.signalingState === 'closed') return;

    const stats = await pc.getStats();
    let quality = 'good';

    // Degrade quality to the worst level seen across all reports
    const degrade = (level) => {
      if (level === 'poor' || (level === 'fair' && quality !== 'poor')) quality = level;
    };

    stats.forEach(report => {
      if (report.kind !== 'audio') return;

      if (report.type === 'inbound-rtp') {
        // Fix #10: measure received audio (what we're hearing)
        const p = prev[report.id] ?? {};
        const deltaLost = (report.packetsLost ?? 0) - (p.packetsLost ?? 0);
        const deltaRecv = (report.packetsReceived ?? 0) - (p.packetsReceived ?? 0);
        prev[report.id] = report;

        if (deltaRecv > 0) {
          const lossRate = Math.max(deltaLost, 0) / (deltaRecv + Math.max(deltaLost, 0));
          const jitter = report.jitter ?? 0;
          if (lossRate > 0.08 || jitter > 0.05) degrade('poor');
          else if (lossRate > 0.02 || jitter > 0.02) degrade('fair');
        }
      } else if (report.type === 'remote-inbound-rtp') {
        // Fix #10: measure outbound audio as seen by remote (what they're hearing)
        const fractionLost = report.fractionLost ?? 0;
        const rtt = report.roundTripTime ?? 0; // seconds
        if (fractionLost > 0.08 || rtt > 0.3) degrade('poor');
        else if (fractionLost > 0.02 || rtt > 0.15) degrade('fair');
      }
    });

    onUpdate(quality);
  }, 5000);

  return () => clearInterval(id);
}

// TextEncoder/Decoder handles non-Latin1 chars safely (e.g. TURN credentials).
// Backward-compatible: ASCII SDP produces identical base64 as the old btoa(JSON…).
export function encodeDescription(desc) {
  const bytes = new TextEncoder().encode(JSON.stringify(desc));
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return btoa(binary);
}

export function decodeDescription(str) {
  const binary = atob(str);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const obj = JSON.parse(new TextDecoder().decode(bytes));
  if (!obj || typeof obj.type !== 'string' || typeof obj.sdp !== 'string') {
    throw new Error('Invalid session description');
  }
  return obj;
}
