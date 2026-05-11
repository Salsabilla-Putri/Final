// File: public/js/sidebar.js

// 1. Fungsi Logout
function handleLogout() {
  if (confirm('Apakah Anda yakin ingin keluar?')) {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('userRole');
    localStorage.removeItem('hasLoginSession');
    localStorage.removeItem('username');
    sessionStorage.removeItem('loginFlowOk');
    localStorage.removeItem('user');
    window.location.replace('login.html');
  }
}

// 2. Load HTML Sidebar ke Layar
document.addEventListener('DOMContentLoaded', function () {
  const container = document.getElementById('sidebar-container');
  if (!container) return;

  fetch('sidebar.html')
    .then(res => res.text())
    .then(data => {
      // Masukkan struktur dasar sidebar
      container.innerHTML = `
        <button class="mobile-menu-toggle" type="button" aria-label="Buka menu">
          <i class="fas fa-bars"></i>
        </button>
        <div class="sidebar-overlay"></div>
        ${data}
      `;

      // Render menu sesuai halaman
      applyCorrectMenu();

      // Nyalakan interaksi sidebar
      setActiveLink();
      initMobileMenu();
    })
    .catch(err => console.error('Gagal memuat sidebar:', err));
});

// 3. Fungsi Utama: Render Menu Sesuai Halaman (Publik vs Teknisi)
function applyCorrectMenu() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    
    // Cek apakah user sedang berada di zona Publik / Masyarakat
    const isPublicPage = page === 'public.html' || page === 'public-user.html';
    const wrap = document.querySelector('.sidebar .nav-items-wrapper');

    if (!wrap) return;

    if (isPublicPage) {
        // --- ZONA WARGA: Timpa sidebar default dengan menu Masyarakat ---
        const isIndex = page === 'public.html';
        const baseUrl = isIndex ? '#' : 'public.html'; // Arahkan kembali ke public.html jika diklik dari pengaturan

        wrap.innerHTML = `
            <a href="${baseUrl}" class="nav-item ${isIndex ? 'public-scroll' : ''}" data-target=".section-overview">
              <span class="nav-icon"><i class="fas fa-home"></i></span>
              <span class="nav-text">Overview</span>
            </a>
            <a href="${baseUrl}" class="nav-item ${isIndex ? 'public-scroll' : ''}" data-target=".section-operations, .section-block:nth-of-type(2)">
              <span class="nav-icon"><i class="fas fa-cogs"></i></span>
              <span class="nav-text">Operations</span>
            </a>
            <a href="${baseUrl}" class="nav-item ${isIndex ? 'public-scroll' : ''}" data-target=".section-analytics">
              <span class="nav-icon"><i class="fas fa-chart-line"></i></span>
              <span class="nav-text">Analytics</span>
            </a>
            <a href="${baseUrl}" class="nav-item ${isIndex ? 'public-scroll' : ''}" data-target=".section-performance, .section-block:nth-of-type(4)">
              <span class="nav-icon"><i class="fas fa-chart-bar"></i></span>
              <span class="nav-text">Performance</span>
            </a>
            <a href="${baseUrl}" class="nav-item ${isIndex ? 'public-scroll' : ''}" data-target=".section-information, .section-block:nth-of-type(5)">
              <span class="nav-icon"><i class="fas fa-info-circle"></i></span>
              <span class="nav-text">Information</span>
            </a>
            <a href="public-user.html" class="nav-item" id="link-public-user">
              <span class="nav-icon"><i class="fas fa-user-circle"></i></span>
              <span class="nav-text">Profil Saya</span>
            </a>
            <a href="#" class="nav-item" id="logout-btn">
              <span class="nav-icon"><i class="fas fa-sign-out-alt"></i></span>
              <span class="nav-text">Logout</span>
            </a>
        `;

        // Fitur Smooth Scroll saat berada di public.html
        if (isIndex) {
            document.querySelectorAll('.public-scroll').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    const targets = el.getAttribute('data-target').split(',');
                    let targetEl = null;
                    for (let t of targets) {
                        targetEl = document.querySelector(t.trim());
                        if (targetEl) break;
                    }
                    if (targetEl) {
                        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        document.body.classList.remove('mobile-sidebar-open');
                    }
                });
            });
        }
    } else {
        // --- ZONA TEKNISI (index.html, engine.html, dll) ---
        // Biarkan menggunakan HTML asli dari sidebar.html
        // Tambahkan tombol logout secara dinamis jika di sidebar.html belum ada
        if (!wrap.innerHTML.includes('Logout')) {
            wrap.innerHTML += `
            <a href="#" class="nav-item" id="logout-btn">
                <span class="nav-icon"><i class="fas fa-sign-out-alt"></i></span>
                <span class="nav-text">Logout</span>
            </a>`;
        }
    }

    // Aktifkan event klik Logout di sidebar
    const logoutBtn = wrap.querySelector('#logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleLogout();
        });
    }
}

// 4. Perbaikan Navigasi Klik Profil
document.addEventListener('click', function (e) {
    // Tangkap klik pada tombol user di Topbar
    const userBtn = e.target.closest('#user-btn') || e.target.closest('.user-info');
    
    // Pastikan yang diklik benar-benar topbar (bukan tombol "quick call" yang pakai class user-info)
    if (userBtn && !window.location.pathname.includes('login.html') && !userBtn.hasAttribute('href')) {
        
        // Logika Pintar: Cek URL saat ini
        const page = window.location.pathname.split('/').pop() || 'index.html';
        const isPublicPage = page === 'public.html' || page === 'public-user.html';

        // Jika dia mengklik profil di halaman warga, arahkan ke profil warga. Jika di halaman teknisi, ke profil teknisi.
        if (isPublicPage) {
            window.location.href = 'public-user.html';
        } else {
            window.location.href = 'user.html';
        }
        return;
    }

    // Tangkap klik logout Global (tombol merah Sign Out di halaman profil)
    const globalLogout = e.target.closest('.btn-del');
    if (globalLogout && globalLogout.innerText.toLowerCase().includes('out')) {
        e.preventDefault();
        handleLogout();
    }
});

// 5. Highlight Warna Biru pada Menu Aktif
function setActiveLink() {
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';

  document.querySelectorAll('.sidebar .nav-item').forEach(a => {
      a.classList.remove('active');
      if (a.getAttribute('href') === page) {
          a.classList.add('active');
      }
  });

  // Tambahan rule manual
  if(page === 'index.html' || page === '') document.getElementById('link-dashboard')?.classList.add('active');
  else if(page.includes('engine')) document.getElementById('link-engine')?.classList.add('active');
  else if(page.includes('history')) document.getElementById('link-history')?.classList.add('active');
  else if(page.includes('reports')) document.getElementById('link-reports')?.classList.add('active');
  else if(page.includes('maintenance')) document.getElementById('link-maintenance')?.classList.add('active');
  else if(page.includes('alarm')) document.getElementById('link-alarm')?.classList.add('active');
  else if(page === 'public-user.html') document.getElementById('link-public-user')?.classList.add('active');
}

// 6. Mobile Menu & Hover Effect Desktop
function initMobileMenu() {
  const toggleBtn = document.querySelector('.mobile-menu-toggle');
  const overlay = document.querySelector('.sidebar-overlay');
  const sidebar = document.querySelector('.sidebar');

  if (toggleBtn) {
      toggleBtn.addEventListener('click', () => document.body.classList.toggle('mobile-sidebar-open'));
  }
  if (overlay) {
      overlay.addEventListener('click', () => document.body.classList.remove('mobile-sidebar-open'));
  }

  if (sidebar) {
      let closeTimer;
      sidebar.addEventListener('mouseenter', () => {
          clearTimeout(closeTimer);
          if (window.innerWidth > 768) document.body.classList.add('sidebar-expanded');
      });
      sidebar.addEventListener('mouseleave', () => {
          clearTimeout(closeTimer);
          closeTimer = setTimeout(() => document.body.classList.remove('sidebar-expanded'), 120);
      });
  }
}