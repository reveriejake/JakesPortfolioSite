// Tab switching between Resume and Portfolio panels.
(function () {
  const tabs = document.querySelectorAll('.tab');
  const panels = {
    resume: document.getElementById('resume'),
    portfolio: document.getElementById('portfolio'),
  };

  function activate(name) {
    if (!panels[name]) return;

    // Panels
    Object.entries(panels).forEach(([key, el]) => {
      const on = key === name;
      el.classList.toggle('is-active', on);
      el.hidden = !on;
    });

    // Tab buttons
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    // Reflect in URL hash without jumping
    history.replaceState(null, '', '#' + name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Any element with [data-tab] switches tabs (nav buttons, hero CTAs, brand).
  document.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      activate(el.dataset.tab);
    });
  });

  // Deep-link support: #portfolio opens that tab on load.
  const initial = (location.hash || '').replace('#', '');
  if (initial === 'portfolio' || initial === 'resume') activate(initial);

  // Footer year
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
