const CACHE_NAME = 'aqi-pro-cache-v1';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap',
    'https://unpkg.com/lucide@latest',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // ❌ Never cache WAQI API
    if (url.hostname.includes('api.waqi.info')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
