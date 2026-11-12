/* Keyboard and focus support for the existing mobile menu runtime. */
(function () {
  'use strict';
  var trigger = document.querySelector('.framer-puef3e');
  var menu = document.getElementById('ff-menu');
  var backdrop = document.getElementById('ff-menu-backdrop');
  if (!trigger || !menu || !backdrop) return;
  var narrow = window.matchMedia('(max-width: 809.98px)');
  function sync() {
    var open = !menu.hidden;
    trigger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  trigger.addEventListener('click', function () {
    sync();
    if (!menu.hidden) menu.querySelector('a').focus({ preventScroll: true });
  });
  backdrop.addEventListener('click', function () { sync(); trigger.focus({ preventScroll: true }); });
  menu.addEventListener('click', function (event) {
    var link = event.target.closest('a');
    if (!link) return;
    sync();
    if (link.hash) {
      var target = document.getElementById(link.hash.slice(1));
      if (target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }
  });
  document.addEventListener('keydown', function (event) {
    // The original runtime closes on Escape before this listener runs.
    if (event.key === 'Escape' && trigger.getAttribute('aria-label') === 'Close menu') {
      sync();
      trigger.focus({ preventScroll: true });
    }
    if (menu.hidden || event.key !== 'Tab') return;
    var links = Array.from(menu.querySelectorAll('a'));
    var items = [trigger].concat(links);
    var index = items.indexOf(document.activeElement);
    event.preventDefault();
    var next = index === -1 ? 0 : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  });
  narrow.addEventListener('change', function () {
    if (!narrow.matches && !menu.hidden) { trigger.click(); trigger.blur(); }
  });
  sync();
})();
