// File: public/js/sidebar.js

function initSidebarEvents() {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function (e) {
      e.preventDefault();

      if (confirm('Apakah Anda yakin ingin keluar?')) {
        localStorage.removeItem('isLoggedIn');
        localStorage.removeItem('userRole');
        localStorage.removeItem('username');
        window.location.replace('login.html');
      }
    });
  }
}

function syncTopbarUserLabel() {
  const profileLabel = localStorage.getItem('username') || 'Pengguna';
  document.querySelectorAll('.user-info span').forEach((el) => {
    el.innerText = profileLabel;
  });
}

function setActiveLink() {
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';

  document.querySelectorAll('.sidebar .nav-item').forEach((a) => a.classList.remove('active'));

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
    if (window.innerWidth > 768) {
      document.body.classList.add('sidebar-expanded');
    }
  };

  const closeSidebar = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      document.body.classList.remove('sidebar-expanded');
    }, 120);
  };

  sidebar.addEventListener('mouseenter', openSidebar);
  sidebar.addEventListener('mouseleave', closeSidebar);
}

function setupMobileSidebarControls() {
  const toggleBtn = document.querySelector('.mobile-menu-toggle');
  const overlay = document.querySelector('.sidebar-overlay');
  const sidebarLinks = document.querySelectorAll('.sidebar .nav-item');

  toggleBtn?.addEventListener('click', () => {
    document.body.classList.toggle('mobile-sidebar-open');
  });

  overlay?.addEventListener('click', closeMobileSidebar);
  sidebarLinks.forEach((link) => link.addEventListener('click', closeMobileSidebar));

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });
}

document.addEventListener('DOMContentLoaded', function () {
  fetch('sidebar.html')
    .then((response) => response.text())
    .then((data) => {
      const container = document.getElementById('sidebar-container');
      if (!container) return;

      container.innerHTML = `
        <button class="mobile-menu-toggle" type="button" aria-label="Buka menu navigasi">
          <i class="fas fa-bars"></i>
        </button>
        <div class="sidebar-overlay"></div>
        ${data}
      `;

      initSidebarEvents();
      setActiveLink();
      setupSidebarHoverState();
      setupMobileSidebarControls();
    })
    .catch((err) => console.error('Gagal memuat sidebar:', err));

  syncTopbarUserLabel();

  document.addEventListener('click', function (e) {
    const userBtn = e.target.closest('#user-btn') || e.target.closest('.user-info');
    if (userBtn && !window.location.pathname.includes('login.html')) {
      window.location.href = 'user.html';
    }
  });
});
