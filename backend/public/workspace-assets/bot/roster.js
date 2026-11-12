// The archived landing opens the current walkthrough instead of a demo dialog.
document.querySelectorAll('[data-open-demo]').forEach(link => {
  link.removeAttribute('data-open-demo');
  link.href = location.pathname.startsWith('/bot/')
    ? `${location.origin}/#/sume/walkthrough`
    : 'http://127.0.0.1:5182/#/sume/walkthrough';
  link.target = '_top';
});
