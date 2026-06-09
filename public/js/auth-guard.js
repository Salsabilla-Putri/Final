(function () {
  const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isAuthPage = page === 'login.html' || page === 'register.html';

  function readStoredUser() {
    try {
      return JSON.parse(localStorage.getItem('user') || 'null');
    } catch (_) {
      return null;
    }
  }

  function normalizeRole(role) {
    return String(role || '').trim().toLowerCase();
  }

  function getStoredAuth() {
    const storedUser = readStoredUser();
    const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true' && localStorage.getItem('hasLoginSession') === 'true';
    const role = normalizeRole(localStorage.getItem('userRole') || storedUser?.role);
    return { isLoggedIn, role, storedUser };
  }

  const { isLoggedIn, role, storedUser } = getStoredAuth();

  // Halaman login/register tidak perlu dicegat guard agar form tetap bisa dipakai.
  if (isAuthPage) {
    return;
  }

  if (!isLoggedIn) {
    window.location.replace('login.html');
    return;
  }

  // Pulihkan flag lama untuk halaman/sidebar yang masih membaca key tersebut.
  localStorage.setItem('isLoggedIn', 'true');
  localStorage.setItem('hasLoginSession', 'true');
  if (storedUser?.name && !localStorage.getItem('username')) localStorage.setItem('username', storedUser.name);
  if (role && !localStorage.getItem('userRole')) localStorage.setItem('userRole', role);
  sessionStorage.setItem('loginFlowOk', 'true');

  const isCitizenRole = ['warga', 'masyarakat', 'viewer', 'user'].includes(role);
  const citizenPages = new Set(['public.html', 'public-user.html']);
  const isCitizenPage = citizenPages.has(page);

  if (isCitizenRole && !isCitizenPage) {
    window.location.replace('public.html');
    return;
  }

  if (!isCitizenRole && isCitizenPage) {
    window.location.replace('index.html');
  }
})();
