(function () {
  const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isAuthPage = page === 'login.html' || page === 'register.html';

  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const hasLoginSession = localStorage.getItem('hasLoginSession') === 'true';
  const role = (localStorage.getItem('userRole') || '').toLowerCase();

  if (isAuthPage) return;

  // Semua halaman selain login/register wajib login dulu.
  if (!isLoggedIn || !hasLoginSession) {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('hasLoginSession');
    localStorage.removeItem('userRole');
    localStorage.removeItem('username');
    localStorage.removeItem('user');
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
