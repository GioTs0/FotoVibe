(() => {
  const key = 'fotovibe-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;

  try {
    const saved = localStorage.getItem(key);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {}

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const dark = theme === 'dark';
    const action = dark ? 'Hellmodus einschalten' : 'Dunkelmodus einschalten';
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', action);
    button.title = action;
    document.getElementById('theme-label').textContent = dark ? 'Hell' : 'Dunkel';
  }

  apply(preference || (system.matches ? 'dark' : 'light'));

  document.addEventListener('DOMContentLoaded', () => {
    apply(preference || (system.matches ? 'dark' : 'light'));
    document.getElementById('theme-toggle').addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch {}
      apply(preference);
    });
  });

  system.addEventListener?.('change', (event) => {
    if (!preference) apply(event.matches ? 'dark' : 'light');
  });
})();
