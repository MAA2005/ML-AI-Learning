const powerSkip = () => {
  if (!chrome.runtime?.id) return; // Prevention for the 'Context Invalidated' error

  chrome.storage.sync.get(['adblock'], (settings) => {
    if (!settings.adblock) return;

    // Detect the ad-showing class on the main player
    const moviePlayer = document.querySelector('#movie_player');
    const video = document.querySelector('video');
    
    // 2026 Check: YouTube often hides ads inside 'ad-showing' classes
    const isAd = moviePlayer?.classList.contains('ad-showing') || 
                 moviePlayer?.classList.contains('ad-interrupting');

    if (isAd && video) {
      // 1. Mute so the 'burst' isn't heard
      video.muted = true;

      // 2. The 'Instant Jump'
      // We set time to a very high number, which forces YouTube to trigger the next 'chapter' (the real video)
      if (isFinite(video.duration)) {
        video.currentTime = video.duration - 0.1;
      }

      // 3. Fast-forward simulation (Fallback)
      video.playbackRate = 16;

      // 4. Click all known 'Skip' button variations
      const skipButtons = [
        '.ytp-ad-skip-button', 
        '.ytp-skip-ad-button', 
        '.ytp-ad-skip-button-modern', 
        '.ytp-ad-skip-button-slot'
      ];
      skipButtons.forEach(selector => {
        document.querySelector(selector)?.click();
      });
    }
  });
};

const blockDistractions = () => {
  if (!chrome.runtime?.id) return;
  chrome.storage.sync.get(['home', 'sidebar', 'comments'], (settings) => {
    const selectors = {
      home: 'ytd-browse[page-subtype="home"], ytd-rich-grid-renderer',
      sidebar: '#secondary',
      comments: '#comments'
    };
    for (const [key, selector] of Object.entries(selectors)) {
      const el = document.querySelector(selector);
      if (el) el.style.display = settings[key] ? 'none' : '';
    }
  });
};

// Check every 50ms. YouTube is fast, we have to be faster.
setInterval(() => {
  powerSkip();
  blockDistractions();
}, 50);