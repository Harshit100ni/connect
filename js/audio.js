// Fix #6 + #7: setupAudioMonitor now returns a stop function that cancels
// the rAF loop and closes the AudioContext, preventing leaks across calls.
export function setupAudioMonitor(stream, avatarId) {
  try {
    const ctx = new (window.AudioContext || window['webkitAudioContext'])();
    // Fix #8: explicitly resume — context may start suspended on some browsers
    ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const stopLoop = monitorVolume(analyser, avatarId);

    return () => {
      stopLoop();
      ctx.close();
    };
  } catch (e) {
    return () => {};
  }
}

function monitorVolume(analyser, avatarId) {
  const data = new Uint8Array(analyser.frequencyBinCount);
  const avatar = document.getElementById(avatarId);
  let rafId;
  let active = true;

  function tick() {
    if (!active) return;
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    avatar.classList.toggle('speaking', avg > 20);
    rafId = requestAnimationFrame(tick);
  }
  tick();

  return () => {
    active = false;
    cancelAnimationFrame(rafId);
    avatar.classList.remove('speaking');
  };
}
