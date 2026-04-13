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
            }
        })
        .catch(err => console.error("Gagal memuat sidebar:", err));
});

// 2. EVENT DELEGATION (Menangani Klik Tombol User & Logout)
document.addEventListener('click', function(e) {
    
    // --- A. LOGIKA TOMBOL USER PROFILE ---
    // Mencari elemen user-btn atau user-info (termasuk icon/text di dalamnya)
    const userBtn = e.target.closest('#user-btn') || e.target.closest('.user-info');
    
    // Pastikan userBtn ada DAN kita sedang tidak di halaman login (untuk mencegah loop jika ada error)
    if (userBtn && !window.location.pathname.includes('login.html')) {
        // Redirect ke halaman user
        window.location.href = 'user.html';
        return; 
    }

    // --- B. LOGIKA TOMBOL LOGOUT ---
    const logoutBtn = e.target.closest('#logout-btn');
    
    if (logoutBtn) {
        e.preventDefault(); 
        
        if (confirm("Apakah Anda yakin ingin keluar?")) {
            // Hapus data sesi login
            localStorage.removeItem('isLoggedIn');
            localStorage.removeItem('userRole');
            localStorage.removeItem('username');

            // Redirect ke login
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