(function () {
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';
  const isLoginPage = page.includes('login.html');
  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const hasLoginSession = localStorage.getItem('hasLoginSession') === 'true';
  const role = localStorage.getItem('userRole') || '';
  const normalizedRole = role.toLowerCase();
  const isPublicRole = normalizedRole === 'warga';
  const isPublicPage = page.includes('public.html');

  // Login page should never auto-switch by itself.
  if (isLoginPage) {
    return;
  }

  // All protected pages require explicit login flow first.
  if (!isLoggedIn || !hasLoginSession) {
    window.location.replace('login.html');
    return;
  }

  if (isLoggedIn && isPublicRole && !isPublicPage) {
    window.location.replace('public.html');
    return;
  }

  if (isLoggedIn && !isPublicRole && isPublicPage) {
    window.location.replace('index.html');
  }
})();
