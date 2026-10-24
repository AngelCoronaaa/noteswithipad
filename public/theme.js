// Se ejecuta antes de pintar para evitar el parpadeo de tema al cargar.
(function () {
  try {
    var mode = localStorage.getItem('theme');
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  } catch (e) {}
})();
