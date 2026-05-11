// File: public/js/sidebar.js

// Fungsi untuk logout
function handleLogout() {
  if (confirm('Apakah Anda yakin ingin keluar?')) {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('userRole');
    localStorage.removeItem('hasLoginSession');
    localStorage.removeItem('username');
    sessionStorage.removeItem('loginFlowOk');
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

// =========================================================================
// [MODIFIKASI KUNCI 1]: Izinkan public-user.html untuk pakai sidebar ini
// =========================================================================
function customizePublicSidebarForCitizen() {
  const page = window.location.pathname.split('/').pop() || '';
  const user = getUserData();
  const role = user?.role?.toLowerCase() || '';
  const isMasyarakat = ['masyarakat', 'warga', 'user', 'viewer'].includes(role);
  
  if (!isMasyarakat) return;
  // Hentikan eksekusi HANYA jika bukan di halaman public.html ATAU public-user.html
  if (page !== 'public.html' && page !== 'public-user.html') return;

  const wrap = document.querySelector('.sidebar .nav-items-wrapper');
  if (!wrap) return;

  const items = [
    { icon: 'fa-home', text: 'Overview', target: '.section-overview' },
    { icon: 'fa-cogs', text: 'Operations', target: '.section-operations' },
    { icon: 'fa-chart-line', text: 'Analytics', target: '.section-analytics' },
    { icon: 'fa-chart-bar', text: 'Performance', target: '.section-performance' },
    { icon: 'fa-info-circle', text: 'Information', target: '.section-information' }
  ];

  // Jika posisi di public-user.html, link klik harus menuju 'public.html'. Jika di public.html, link hanya '#'.
  const baseUrl = page === 'public.html' ? '#' : 'public.html';

  wrap.innerHTML = items.map((item) => `
    <a href="${baseUrl}" class="nav-item public-nav-item" data-target="${item.target}">
      <span class="nav-icon"><i class="fas ${item.icon}"></i></span>
      <span class="nav-text">${item.text}</span>
    </a>
  `).join('') + `
    <a href="public-user.html" class="nav-item">
      <span class="nav-icon"><i class="fas fa-user-circle"></i></span>
      <span class="nav-text">Profil Saya</span>
    </a>
    <a href="#" id="logout-btn" class="nav-item">
      <span class="nav-icon"><i class="fas fa-sign-out-alt"></i></span>
      <span class="nav-text">Logout</span>
    </a>
  `;

  wrap.querySelectorAll('.public-nav-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      // Smooth scroll hanya jika sedang berada di public.html
      if (page === 'public.html') {
          e.preventDefault();
          const t = document.querySelector(el.dataset.target);
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          closeMobileSidebar();
      }
    });
  });
  wrap.querySelector('#logout-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    handleLogout();
  });
}

// =========================================================================
// [MODIFIKASI KUNCI 2]: Izinkan public-user.html di renderSidebarMenu
// =========================================================================
function renderSidebarMenu() {
  const user = getUserData();
  const role = user?.role?.toLowerCase() || '';
  const isTeknisi = role === 'teknisi' || role === 'admin';
  const isMasyarakat = ['masyarakat', 'warga', 'user', 'viewer'].includes(role);
  const page = window.location.pathname.split('/').pop() || 'index.html';

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
    const isPublicPage = page === 'public.html' || page === 'public-user.html';
    const isIndex = page === 'public.html';

    menuItems = isPublicPage ? [
      { icon: 'fa-home', text: 'Overview', link: isIndex ? '#' : 'public.html', onclick: isIndex ? "document.querySelector('.section-overview')?.scrollIntoView({behavior:'smooth'})" : null },
      { icon: 'fa-cogs', text: 'Operations', link: isIndex ? '#' : 'public.html', onclick: isIndex ? "document.querySelectorAll('.section-block')[1]?.scrollIntoView({behavior:'smooth'})" : null },
      { icon: 'fa-chart-line', text: 'Analytics', link: isIndex ? '#' : 'public.html', onclick: isIndex ? "document.querySelector('.section-analytics')?.scrollIntoView({behavior:'smooth'})" : null },
      { icon: 'fa-chart-bar', text: 'Performance', link: isIndex ? '#' : 'public.html', onclick: isIndex ? "document.querySelectorAll('.section-block')[3]?.scrollIntoView({behavior:'smooth'})" : null },
      { icon: 'fa-info-circle', text: 'Information', link: isIndex ? '#' : 'public.html', onclick: isIndex ? "document.querySelectorAll('.section-block')[4]?.scrollIntoView({behavior:'smooth'})" : null },
      { icon: 'fa-user-circle', text: 'Profil Saya', link: 'public-user.html' },
      { icon: 'fa-sign-out-alt', text: 'Logout', link: '#', onclick: 'handleLogout' }
    ] : [
      { icon: 'fa-home', text: 'Dashboard Warga', link: 'public.html' },
      { icon: 'fa-user-circle', text: 'Profil Saya', link: 'public-user.html' },
      { icon: 'fa-sign-out-alt', text: 'Logout', link: '#', onclick: 'handleLogout' }
    ];
  } else {
    window.location.href = 'login.html';
    return;
  }

  const menuHtml = menuItems.map(item => `
    <a href="${item.link}" class="sidebar-item" ${item.onclick ? `onclick="${item.onclick}; return false;"` : ''}>
      <i class="fas ${item.icon}"></i> ${item.text}
    </a>
  `).join('');

  const sidebarMenu = document.querySelector('.sidebar-menu');
  if (sidebarMenu) sidebarMenu.innerHTML = menuHtml;

  document.querySelectorAll('.sidebar-item[onclick*="handleLogout"]').forEach(el => {
    el.removeAttribute('onclick');
    el.addEventListener('click', (e) => {
      e.preventDefault();
      handleLogout();
    });
  });
}

// =========================================================================
// [MODIFIKASI KUNCI 3]: Izinkan public-user.html di applyPublicSectionSidebar
// =========================================================================
function applyPublicSectionSidebar() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  if (page !== 'public.html' && page !== 'public-user.html') return;

  const wrap = document.querySelector('.sidebar .nav-items-wrapper');
  if (!wrap) return;
  const sections = [
    { icon: 'fa-home', text: 'Overview', selector: '.section-overview' },
    { icon: 'fa-cogs', text: 'Operations', selector: '.section-block:nth-of-type(2)' },
    { icon: 'fa-chart-line', text: 'Analytics', selector: '.section-analytics' },
    { icon: 'fa-chart-bar', text: 'Performance', selector: '.section-block:nth-of-type(4)' },
    { icon: 'fa-info-circle', text: 'Information', selector: '.section-block:nth-of-type(5)' }
  ];

  const baseUrl = page === 'public.html' ? '#' : 'public.html';

  wrap.innerHTML = sections.map((item) => `
    <a href="${baseUrl}" class="nav-item public-section-link" data-target="${item.selector}">
      <span class="nav-icon"><i class="fas ${item.icon}"></i></span>
      <span class="nav-text">${item.text}</span>
    </a>`).join('') + `
    <a href="public-user.html" class="nav-item">
      <span class="nav-icon"><i class="fas fa-user-circle"></i></span>
      <span class="nav-text">Profil Saya</span>
    </a>
    <a href="#" id="logout-btn" class="nav-item">
      <span class="nav-icon"><i class="fas fa-sign-out-alt"></i></span>
      <span class="nav-text">Logout</span>
    </a>`;

  wrap.querySelectorAll('.public-section-link').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (page === 'public.html') {
          e.preventDefault();
          const target = document.querySelector(el.dataset.target);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  document.getElementById('logout-btn')?.addEventListener('click', (e) => { e.preventDefault(); handleLogout(); });
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
      applyPublicSectionSidebar();

      // Inisialisasi event lain
      customizePublicSidebarForCitizen();
      setActiveLink();
      setupSidebarHoverState();
      setupMobileSidebarControls();
      syncTopbarUserLabel();

      // =========================================================================
      // [MODIFIKASI KUNCI 4]: Perbaiki redirect Tombol Profil di Topbar
      // =========================================================================
      document.addEventListener('click', function (e) {
        const userBtn = e.target.closest('#user-btn');
        if (userBtn && !window.location.pathname.includes('login.html')) {
          
          const role = user?.role?.toLowerCase() || '';
          const isMasyarakat = ['masyarakat', 'warga', 'user', 'viewer'].includes(role);
          
          if (isMasyarakat) {
            window.location.href = 'public-user.html'; // Warga diarahkan ke sini
          } else {
            window.location.href = 'user.html'; // Teknisi diarahkan ke sini
          }
        }
      });
    })
    .catch(err => console.error('Gagal memuat sidebar:', err));
});