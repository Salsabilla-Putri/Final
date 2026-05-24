(function () {
  const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isAuthPage = page === 'login.html' || page === 'register.html';

  if (isAuthPage) {
    return;
  }

  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const hasLoginSession = localStorage.getItem('hasLoginSession') === 'true';
  const loginFlowOk = sessionStorage.getItem('loginFlowOk') === 'true';
  const role = (localStorage.getItem('userRole') || '').toLowerCase();
  const isPublicPage = page === 'public.html';
  const isCitizenRole = ['warga', 'masyarakat', 'viewer', 'user'].includes(role);

  if (!isLoggedIn || !hasLoginSession || !loginFlowOk) {
    window.location.replace('login.html');
    return;
  }

  if (isCitizenRole && !isPublicPage) {
    window.location.replace('public.html');
    return;
  }

  if (!isCitizenRole && isPublicPage) {
    window.location.replace('index.html');
  }
})();
