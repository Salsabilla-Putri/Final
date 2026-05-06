(function (global) {
  function normalizeRole(role) {
    return String(role || '').trim().toLowerCase();
  }

  function canonicalRole(role) {
    const normalized = normalizeRole(role);
    return normalized === 'masyarakat' ? 'warga' : normalized;
  }

  function isPublicRole(role) {
    const normalized = normalizeRole(role);
    return normalized === 'warga' || normalized === 'masyarakat';
  }

  global.RoleUtils = {
    normalizeRole,
    canonicalRole,
    isPublicRole
  };
})(window);
