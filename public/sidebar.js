// File: public/js/sidebar.js

document.addEventListener("DOMContentLoaded", function() {
    // 1. Muat Sidebar
    fetch('sidebar.html')
        .then(response => {
            if (!response.ok) throw new Error("Gagal load sidebar");
            return response.text();
        })
        .then(data => {
            const container = document.getElementById('sidebar-container');
            if (container) {
                container.innerHTML = data;
                
                // --- INI KUNCI UTAMANYA: Mengganti menu default ke menu Masyarakat ---
                applyRoleBasedSidebar();
                
                setActiveLink();
                initMobileMenu();
            }
        })
        .catch(err => console.error("Gagal memuat sidebar:", err));
});

// FUNGSI UTAMA: Mengganti menu teknisi menjadi menu warga jika yang login adalah Masyarakat
function applyRoleBasedSidebar() {
    const role = localStorage.getItem('userRole') || 'masyarakat';
    const isMasyarakat = ['masyarakat', 'warga', 'user', 'viewer'].includes(role.toLowerCase());
    const wrapper = document.querySelector('.sidebar .nav-items-wrapper');
    const page = window.location.pathname.split('/').pop() || 'index.html';
    
    if (!wrapper) return;

    // Jika user adalah Masyarakat, kita ganti isi sidebarnya!
    if (isMasyarakat) {
        // Berlaku untuk public.html maupun public-user.html
        if (page === 'public.html' || page === 'public-user.html') {
            const isPublic = page === 'public.html';
            
            // Menu Sidebar yang senada untuk kedua halaman
            wrapper.innerHTML = `
                <a href="${isPublic ? '#' : 'public.html'}" class="nav-item ${isPublic ? 'public-scroll' : ''}" data-target=".section-overview">
                    <span class="nav-icon"><i class="fas fa-home"></i></span>
                    <span class="nav-text">Overview</span>
                </a>
                <a href="${isPublic ? '#' : 'public.html'}" class="nav-item ${isPublic ? 'public-scroll' : ''}" data-target=".section-operations, .section-block:nth-of-type(2)">
                    <span class="nav-icon"><i class="fas fa-cogs"></i></span>
                    <span class="nav-text">Operations</span>
                </a>
                <a href="${isPublic ? '#' : 'public.html'}" class="nav-item ${isPublic ? 'public-scroll' : ''}" data-target=".section-analytics">
                    <span class="nav-icon"><i class="fas fa-chart-line"></i></span>
                    <span class="nav-text">Analytics</span>
                </a>
                <a href="${isPublic ? '#' : 'public.html'}" class="nav-item ${isPublic ? 'public-scroll' : ''}" data-target=".section-performance, .section-block:nth-of-type(4)">
                    <span class="nav-icon"><i class="fas fa-chart-bar"></i></span>
                    <span class="nav-text">Performance</span>
                </a>
                <a href="${isPublic ? '#' : 'public.html'}" class="nav-item ${isPublic ? 'public-scroll' : ''}" data-target=".section-information, .section-block:nth-of-type(5)">
                    <span class="nav-icon"><i class="fas fa-info-circle"></i></span>
                    <span class="nav-text">Information</span>
                </a>
                <a href="public-user.html" class="nav-item" id="link-public-user">
                    <span class="nav-icon"><i class="fas fa-user-circle"></i></span>
                    <span class="nav-text">Profil Saya</span>
                </a>
            `;

            // Jika di halaman public.html, klik menu akan melakukan Smooth Scroll
            if (isPublic) {
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
                            if (window.innerWidth <= 768) document.body.classList.remove('mobile-sidebar-open');
                        }
                    });
                });
            }
        }
    }
}

// EVENT GLOBAL UNTUK KLIK USER PROFILE & LOGOUT
document.addEventListener('click', function(e) {
    
    // --- Klik User Profile di Topbar ---
    const userBtn = e.target.closest('#user-btn') || e.target.closest('.user-info');
    if (userBtn && !window.location.pathname.includes('login.html')) {
        const role = localStorage.getItem('userRole') || 'masyarakat';
        const isMasyarakat = ['masyarakat', 'warga', 'user', 'viewer'].includes(role.toLowerCase());
        
        // Arahkan ke halaman pengaturan yang benar sesuai Role
        if (isMasyarakat) {
            window.location.href = 'public-user.html';
        } else {
            window.location.href = 'user.html';
        }
        return; 
    }

    // --- Klik Logout dari mana saja ---
    const logoutBtn = e.target.closest('#logout-btn') || e.target.closest('.btn-del'); // Termasuk tombol sign out merah
    if (logoutBtn && logoutBtn.innerText.toLowerCase().includes('out')) {
        e.preventDefault(); 
        if (confirm("Apakah Anda yakin ingin keluar?")) {
            localStorage.removeItem('isLoggedIn');
            localStorage.removeItem('userRole');
            localStorage.removeItem('username');
            window.location.replace('login.html'); 
        }
    }
});

// SET ACTIVE LINK BERDASARKAN HALAMAN
function setActiveLink() {
    const path = window.location.pathname;
    const page = path.split('/').pop() || 'index.html';
    
    document.querySelectorAll('.sidebar .nav-item').forEach(a => a.classList.remove('active'));

    if(page === 'index.html' || page === '') document.getElementById('link-dashboard')?.classList.add('active');
    else if(page.includes('engine')) document.getElementById('link-engine')?.classList.add('active');
    else if(page.includes('history')) document.getElementById('link-history')?.classList.add('active');
    else if(page.includes('reports')) document.getElementById('link-reports')?.classList.add('active');
    else if(page.includes('maintenance')) document.getElementById('link-maintenance')?.classList.add('active');
    else if(page.includes('alarm')) document.getElementById('link-alarm')?.classList.add('active');
    else if(page === 'public-user.html') document.getElementById('link-public-user')?.classList.add('active'); // Warna biru jika di page profil
}

// MOBILE MENU TOGGLE
function initMobileMenu() {
    const toggleBtn = document.querySelector('.mobile-menu-toggle');
    const overlay = document.querySelector('.sidebar-overlay');
    
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
            document.body.classList.toggle('mobile-sidebar-open');
        });
    }
    
    if (overlay) {
        overlay.addEventListener('click', function() {
            document.body.classList.remove('mobile-sidebar-open');
        });
    }
    
    // Tutup sidebar saat menu diklik di mode HP
    document.querySelectorAll('#sidebar-container .nav-item').forEach(link => {
        link.addEventListener('click', function() {
            if (window.innerWidth <= 768) {
                document.body.classList.remove('mobile-sidebar-open');
            }
        });
    });
}