const options = ['home', 'sidebar', 'comments', 'adblock'];

chrome.storage.sync.get(options, (data) => {
  options.forEach(key => {
    document.getElementById(key).checked = data[key] || false;
  });
});

document.addEventListener('change', (e) => {
  const settings = {};
  settings[e.target.id] = e.target.checked;
  chrome.storage.sync.set(settings);
});