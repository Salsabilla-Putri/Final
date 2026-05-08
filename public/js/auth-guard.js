(function () {
  const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isAuthPage = page === 'login.html' || page === 'register.html';

  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const hasLoginSession = localStorage.getItem('hasLoginSession') === 'true';
  const loginFlowOk = sessionStorage.getItem('loginFlowOk') === 'true';
  const role = localStorage.getItem('userRole') || '';
  const normalizedRole = role.toLowerCase();
  const isPublicRole = normalizedRole === 'warga';
  const isPublicPage = page.includes('public.html');

  // Login page should never auto-switch by itself.
  if (isLoginPage || isRegisterPage) {
    return;
  }

  // All protected pages require explicit login flow first.
  if (!isLoggedIn || !hasLoginSession || !loginFlowOk) {
    window.location.replace('login.html');
    return;
  }

  const isPublicPage = page === 'public.html';
  const isCitizenRole = ['warga', 'masyarakat', 'viewer', 'user'].includes(role);

  if (isCitizenRole && !isPublicPage) {
    window.location.replace('public.html');
    return;
  }

  if (!isCitizenRole && isPublicPage) {
    window.location.replace('index.html');
  }
})();
