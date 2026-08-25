(function () {
  // Project videos are thumbnail facades until clicked, so the page loads one
  // YouTube player (the reel) instead of three.
  document.querySelectorAll('.lite-yt').forEach((btn) => {
    // maxresdefault doesn't exist for every upload — fall back to hqdefault.
    const img = btn.querySelector('img');
    if (img) {
      img.addEventListener('error', function onErr() {
        img.removeEventListener('error', onErr);
        img.src = 'https://i.ytimg.com/vi/' + btn.dataset.yt + '/hqdefault.jpg';
      });
    }

    btn.addEventListener('click', () => {
      const frame = document.createElement('iframe');
      frame.src =
        'https://www.youtube-nocookie.com/embed/' + btn.dataset.yt + '?autoplay=1&rel=0';
      frame.title = btn.dataset.ytTitle || 'Video';
      frame.allow =
        'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allowFullscreen = true;
      btn.replaceWith(frame);
    });
  });

  // Footer year
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
