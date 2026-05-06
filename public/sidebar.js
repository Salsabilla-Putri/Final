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
                setActiveLink();
                initMobileMenu();
            }
        })
        .catch(err => console.error("Gagal memuat sidebar:", err));
});

// 2. EVENT DELEGATION (Menangani Klik Tombol User & Logout)
document.addEventListener('click', function(e) {
    
    // --- A. LOGIKA TOMBOL USER PROFILE ---
    const userBtn = e.target.closest('#user-btn') || e.target.closest('.user-info');
    
    if (userBtn && !window.location.pathname.includes('login.html')) {
        window.location.href = 'user.html';
        return; 
    }

    // --- B. LOGIKA TOMBOL LOGOUT ---
    const logoutBtn = e.target.closest('#logout-btn');
    
    if (logoutBtn) {
        e.preventDefault(); 
        
        if (confirm("Apakah Anda yakin ingin keluar?")) {
            localStorage.removeItem('isLoggedIn');
            localStorage.removeItem('userRole');
            localStorage.removeItem('username');

            window.location.replace('login.html'); 
        }
    }
});

// 3. FUNGSI HIGHLIGHT MENU AKTIF
function setActiveLink() {
    const path = window.location.pathname;
    const page = path.split("/").pop() || 'index.html';

    document.querySelectorAll('.sidebar .nav-item').forEach(a => {
        a.classList.remove('active');
    });

    if(page === 'index.html' || page === '') document.getElementById('link-dashboard')?.classList.add('active');
    else if(page.includes('engine')) document.getElementById('link-engine')?.classList.add('active');
    else if(page.includes('history')) document.getElementById('link-history')?.classList.add('active');
    else if(page.includes('reports')) document.getElementById('link-reports')?.classList.add('active');
    else if(page.includes('maintenance')) document.getElementById('link-maintenance')?.classList.add('active');
    else if(page.includes('alarm')) document.getElementById('link-alarm')?.classList.add('active');
}

// 4. MOBILE MENU TOGGLE
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
    
    // Tutup sidebar saat klik link di mobile
    document.querySelectorAll('#sidebar-container .nav-item').forEach(link => {
        link.addEventListener('click', function() {
            if (window.innerWidth <= 768) {
                document.body.classList.remove('mobile-sidebar-open');
            }
        });
    });
}