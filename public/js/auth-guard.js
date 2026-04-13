(function () {
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';
  const isLoginPage = page.includes('login.html');
  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const role = localStorage.getItem('userRole') || '';
  const isPublicRole = role.toLowerCase() === 'masyarakat';
  const isPublicPage = page.includes('public.html');

  if (!isLoginPage && !isLoggedIn) {
    window.location.replace('login.html');
    return;
  }

  if (isLoginPage && isLoggedIn) {
    window.location.replace(isPublicRole ? 'public.html' : 'index.html');
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
