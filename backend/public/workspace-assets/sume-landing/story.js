// Resize only this page's same-origin illustration frames; no cross-frame actions.
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.data?.type !== 'sume-demo-height') return;
  const frame = [...document.querySelectorAll('iframe.sume-story-demo')].find(el => el.contentWindow === event.source);
  const height = Number(event.data.height);
  if (frame && Number.isFinite(height) && height >= 200 && height <= 1400) {
    frame.style.setProperty('--sume-demo-height', `${Math.ceil(height)}px`);
  }
});
