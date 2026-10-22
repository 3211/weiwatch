(() => {
  'use strict';

  const form = document.getElementById('login-form');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const button = document.getElementById('login-button');
  const errorBox = document.getElementById('login-error');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    const user = username.value.trim();
    const pass = password.value;
    if (!user || !pass) {
      showError('Enter your username and password.');
      return;
    }

    button.disabled = true;
    button.textContent = 'Signing in...';

    try {
      const response = await fetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: user, password: pass }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        showError(data.error || 'Could not sign in.');
        password.value = '';
        password.focus();
        return;
      }

      window.location.href = 'app';
    } catch {
      showError('Network error. Try again.');
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
})();
