// File: public/js/sidebar.js

// Fungsi untuk logout
function handleLogout() {
  if (confirm('Apakah Anda yakin ingin keluar?')) {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('userRole');
    localStorage.removeItem('hasLoginSession');
    localStorage.removeItem('username');
    localStorage.removeItem('user'); // hapus juga key user
    window.location.replace('login.html');
  }
}

// Ambil data user dari localStorage (prioritas user object atau isLoggedIn)
function getUserData() {
  const userStr = localStorage.getItem('user');
  if (userStr) {
    try {
      const user = JSON.parse(userStr);
      return { role: user.role, username: user.name || user.email };
    } catch(e) {}
  }
  // fallback ke isLoggedIn style
  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  if (!isLoggedIn) return null;
  return {
    role: localStorage.getItem('userRole') || 'masyarakat',
    username: localStorage.getItem('username') || 'Pengguna'
  };
}

// Sinkron label user di topbar
function syncTopbarUserLabel() {
  const user = getUserData();
  const name = user?.username || 'Pengguna';
  document.querySelectorAll('.user-info span').forEach(el => {
    el.innerText = name;
  });
}

// Set active link berdasarkan halaman
function setActiveLink() {
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';

  document.querySelectorAll('.sidebar .nav-item, .sidebar .sidebar-item').forEach(a => a.classList.remove('active'));

  if (page === 'index.html' || page === '') document.getElementById('link-dashboard')?.classList.add('active');
  else if (page.includes('engine')) document.getElementById('link-engine')?.classList.add('active');
  else if (page.includes('history')) document.getElementById('link-history')?.classList.add('active');
  else if (page.includes('reports')) document.getElementById('link-reports')?.classList.add('active');
  else if (page.includes('maintenance')) document.getElementById('link-maintenance')?.classList.add('active');
  else if (page.includes('alarm')) document.getElementById('link-alarm')?.classList.add('active');
}

function closeMobileSidebar() {
  document.body.classList.remove('mobile-sidebar-open');
}

function setupSidebarHoverState() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  let closeTimer;
  const openSidebar = () => {
    clearTimeout(closeTimer);
    if (window.innerWidth > 768) document.body.classList.add('sidebar-expanded');
  };
  const closeSidebar = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => document.body.classList.remove('sidebar-expanded'), 120);
  };
  sidebar.addEventListener('mouseenter', openSidebar);
  sidebar.addEventListener('mouseleave', closeSidebar);
}

function setupMobileSidebarControls() {
  const toggleBtn = document.querySelector('.mobile-menu-toggle');
  const overlay = document.querySelector('.sidebar-overlay');
  const sidebarLinks = document.querySelectorAll('.sidebar .nav-item, .sidebar .sidebar-item');
  toggleBtn?.addEventListener('click', () => document.body.classList.toggle('mobile-sidebar-open'));
  overlay?.addEventListener('click', closeMobileSidebar);
  sidebarLinks.forEach(link => link.addEventListener('click', closeMobileSidebar));
  window.addEventListener('resize', () => { if (window.innerWidth > 768) closeMobileSidebar(); });
}

// Render sidebar berdasarkan role (dipanggil setelah konten sidebar dimuat)
function renderSidebarMenu() {
  const user = getUserData();
  const role = user?.role?.toLowerCase() || '';
  const isTeknisi = role === 'teknisi' || role === 'admin';
  const isMasyarakat = role === 'masyarakat' || role === 'warga' || role === 'user' || role === 'viewer';

  let menuItems = [];
  if (isTeknisi) {
    menuItems = [
      { icon: 'fa-tachometer-alt', text: 'Dashboard', link: 'dashboard.html' },
      { icon: 'fa-chart-line', text: 'Parameter', link: 'dashboard.html#parameters' },
      { icon: 'fa-tools', text: 'Maintenance', link: 'dashboard.html#maintenance' },
      { icon: 'fa-bell', text: 'Alerts', link: 'dashboard.html#alerts' },
      { icon: 'fa-file-alt', text: 'Laporan', link: 'reports.html' },
      { icon: 'fa-sign-out-alt', text: 'Logout', link: '#', onclick: 'handleLogout' }
    ];
  } else if (isMasyarakat) {
    const isPublicPage = (window.location.pathname.split('/').pop() || '') === 'public.html';
    menuItems = isPublicPage ? [
      { icon: 'fa-home', text: 'Overview', link: '#', onclick: "document.querySelector('.section-overview')?.scrollIntoView({behavior:'smooth'})" },
      { icon: 'fa-cogs', text: 'Operations', link: '#', onclick: "document.querySelectorAll('.section-block')[1]?.scrollIntoView({behavior:'smooth'})" },
      { icon: 'fa-chart-line', text: 'Analytics', link: '#', onclick: "document.querySelector('.section-analytics')?.scrollIntoView({behavior:'smooth'})" },
      { icon: 'fa-chart-bar', text: 'Performance', link: '#', onclick: "document.querySelectorAll('.section-block')[3]?.scrollIntoView({behavior:'smooth'})" },
      { icon: 'fa-info-circle', text: 'Information', link: '#', onclick: "document.querySelectorAll('.section-block')[4]?.scrollIntoView({behavior:'smooth'})" },
      { icon: 'fa-sign-out-alt', text: 'Logout', link: '#', onclick: 'handleLogout' }
    ] : [
      { icon: 'fa-home', text: 'Dashboard Warga', link: 'public.html' },
      { icon: 'fa-sign-out-alt', text: 'Logout', link: '#', onclick: 'handleLogout' }
    ];
  } else {
    // Belum login, arahkan ke login
    window.location.href = 'login.html';
    return;
  }

  const menuHtml = menuItems.map(item => `
    <a href="${item.link}" class="nav-item sidebar-item" ${item.onclick ? `onclick="${item.onclick}; return false;"` : ''}>
      <span class="nav-icon"><i class="fas ${item.icon}"></i></span>
      <span class="nav-text">${item.text}</span>
    </a>
  `).join('');

  const sidebarMenu = document.querySelector('.sidebar-menu');
  const navWrapper = document.querySelector('.nav-items-wrapper');
  if (sidebarMenu) sidebarMenu.innerHTML = menuHtml;
  else if (navWrapper) navWrapper.innerHTML = menuHtml;

  // Pasang ulang event listener untuk logout
  document.querySelectorAll('.sidebar-item[onclick*="handleLogout"]').forEach(el => {
    el.removeAttribute('onclick');
    el.addEventListener('click', (e) => {
      e.preventDefault();
      handleLogout();
    });
  });
}

// Inisialisasi sidebar (load template, lalu render menu)
document.addEventListener('DOMContentLoaded', function () {
  const container = document.getElementById('sidebar-container');
  if (!container) return;

  // Cek login dulu sebelum render sidebar
  const user = getUserData();
  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  fetch('sidebar.html')
    .then(response => response.text())
    .then(data => {
      container.innerHTML = `
        <button class="mobile-menu-toggle" type="button" aria-label="Buka menu navigasi">
          <i class="fas fa-bars"></i>
        </button>
        <div class="sidebar-overlay"></div>
        ${data}
      `;

      // Render menu dinamis berdasarkan role
      renderSidebarMenu();

      // Inisialisasi event lain
      setActiveLink();
      setupSidebarHoverState();
      setupMobileSidebarControls();
      syncTopbarUserLabel();

      // Event untuk tombol user di topbar (jika ada)
      document.addEventListener('click', function (e) {
        const userBtn = e.target.closest('#user-btn') || e.target.closest('.user-info');
        if (userBtn && !window.location.pathname.includes('login.html')) {
          window.location.href = 'user.html';
        }
      });
    })
    .catch(err => console.error('Gagal memuat sidebar:', err));
});
