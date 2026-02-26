// Final target for production (empty for relative paths when served from server)
const PROXY_BASE = "";
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes in ms

let trendChart = null;
let aqiMap = null;
let markers = [];
let favorites = JSON.parse(localStorage.getItem('aqi_favorites')) || [];
let recentSearches = JSON.parse(localStorage.getItem('aqi_recents')) || [];
let currentCityData = null;
let selectedIndex = -1;
let currentSuggestions = [];
const suggestionCache = {}; // Query → API results cache

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  // Initial data load
  initApp();

  // Setup search functionality
  setupSearch();

  // Add click listener to close modal on outside click
  window.onclick = (event) => {
    const modal = document.getElementById('infoModal');
    if (event.target === modal) closeModal();
  };

  // Enter key on input triggers search only when no suggestion is keyboard-selected
  document.getElementById('cityInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && selectedIndex < 0) getAQI();
  });

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').then(reg => {
        console.log('SW registered!', reg);
      }).catch(err => {
        console.log('SW registration failed: ', err);
      });
    });
  }
});

async function initApp() {
  // Check if we have a saved city or use default
  const savedCity = localStorage.getItem('lastCity');
  if (savedCity) {
    getAQI(savedCity);
  } else {
    // Default to current location if possible, otherwise Pune
    useGeolocation(true);
  }
}

// --- Core Functionality ---

async function getAQI(cityOverride) {
  const cityInput = document.getElementById("cityInput").value.trim();
  const city = cityOverride || cityInput || "Pune";

  showLoader(true);

  try {
    // Check Cache first
    const cacheKey = `aqi_${city.toLowerCase()}`;
    const cached = localStorage.getItem(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.timestamp < CACHE_DURATION) {
        console.log("Using cached data for", city);
        updateUI(parsed.data);
        showLoader(false);
        return;
      }
    }

    let searchUrl = city.startsWith('@')
      ? `${PROXY_BASE}/api/feed/${city.substring(1)}`
      : `${PROXY_BASE}/api/feed/${encodeURIComponent(city)}`;

    let response = await fetch(searchUrl);
    let data = await response.json();

    // If city not found and not a direct UID/Geo, try geocoding
    if (data.status !== "ok" && !city.startsWith('@') && !city.startsWith('geo:')) {
      console.log(`Location "${city}" not found in AQI API index. Trying geocoding...`);
      const geoResponse = await fetch(`${PROXY_BASE}/api/geocode?q=${encodeURIComponent(city)}`);
      const geoData = await geoResponse.json();

      if (geoData && geoData.length > 0) {
        const { lat, lon, display_name } = geoData[0];
        console.log(`Geocoded "${city}" to ${lat}, ${lon} (${display_name})`);

        searchUrl = `${PROXY_BASE}/api/feed/geo/${lat}/${lon}`;
        response = await fetch(searchUrl);
        data = await response.json();

        if (data.status === "ok") {
          // Add a flag to show we are showing the nearest station
          data.data.isNearest = true;
          data.data.searchedName = city;
        }
      }
    }

    if (data.status !== "ok") {
      alert(`Location "${city}" not found! Try another location.`);
      showLoader(false);
      return;
    }

    if (!data.data || !data.data.city) {
      throw new Error("Invalid data format received from API");
    }

    // Save to cache
    localStorage.setItem(cacheKey, JSON.stringify({
      timestamp: Date.now(),
      data: data.data
    }));
    localStorage.setItem('lastCity', city);

    // Save to recents if valid
    const safeCityName = data.data.city?.name ? data.data.city.name.split(',')[0] : city;
    saveToRecents(safeCityName);

    updateUI(data.data);

    if (data.data.city?.geo && data.data.city.geo.length >= 2) {
      fetchNearbyStations(data.data.city.geo[0], data.data.city.geo[1]);
    }

  } catch (error) {
    console.error("AQI Fetch Error Details:", {
      message: error.message,
      stack: error.stack,
      city: city
    });

    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      alert("Network error! Please check your internet connection.");
    } else {
      alert(`App error: ${error.message || "Unable to process air quality data"}. Please try again later.`);
    }
  } finally {
    showLoader(false);
  }
}

function updateUI(data) {
  if (!data) {
    console.error("updateUI called with null/undefined data");
    return;
  }

  const aqi = data.aqi;
  // Handle case where AQI might be missing or explicitly null
  if (aqi === undefined || aqi === null || aqi === "-") {
    console.warn("AQI value missing for this station", data);
    document.getElementById("aqiValue").innerText = "--";
    document.getElementById("categoryText").innerText = "Data Unavailable";
    document.getElementById("healthAdvice").innerText = "This station is currently not reporting AQI levels.";
    return;
  }

  const category = getAQICategory(aqi);

  // Update Theme
  document.body.className = `theme-${category.id}`;

  // Animate Counter
  animateValue("aqiValue", 0, aqi, 1000);

  // Update Text info
  const cityName = data.isNearest && data.searchedName
    ? data.searchedName
    : (data.city?.name ? data.city.name.split(',')[0] : "Unknown");

  document.getElementById("cityNameText").innerText = cityName;
  document.getElementById("categoryText").innerText = category.text;
  document.getElementById("healthAdvice").innerText = category.advice;

  const stationLabel = data.isNearest ? "Nearest Station" : "Station";
  document.getElementById("stationName").innerText = `${stationLabel}: ${data.city?.name || "Unknown"}`;

  if (data.time?.v) {
    document.getElementById("lastUpdated").innerText = `Updated: ${new Date(data.time.v * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Update Favorite Button State
  const favBtn = document.getElementById('favoriteBtn');
  if (favBtn) {
    const isFav = favorites.includes(cityName);
    favBtn.classList.toggle('active', isFav);

    // Ensure the star icon is updated correctly using lucide
    // Lucide replaces <i> with <svg>, so we look for both
    const favIcon = favBtn.querySelector('i, svg');
    if (favIcon) {
      favIcon.setAttribute('data-lucide', 'star');
      favIcon.style.fill = isFav ? "currentColor" : "none";
    }
  }
  lucide.createIcons();

  // Store globally for other features
  currentCityData = data;

  // Update Pollutants
  if (data.iaqi) updatePollutants(data.iaqi);

  // Update Charts
  if (data.forecast && data.forecast.daily) updateTrends(data.forecast.daily);
}

function getAQICategory(aqi) {
  if (aqi <= 50) return { id: 'good', text: "Good", advice: "Air quality is satisfactory, and air pollution poses little or no risk." };
  if (aqi <= 100) return { id: 'moderate', text: "Moderate", advice: "Air quality is acceptable. However, people with respiratory conditions may be affected." };
  if (aqi <= 150) return { id: 'unhealthy-sens', text: "Unhealthy for Sensitive Groups", advice: "Members of sensitive groups may experience health effects. General public is less likely to be affected." };
  if (aqi <= 200) return { id: 'unhealthy', text: "Unhealthy", advice: "Everyone may begin to experience health effects; members of sensitive groups may experience more serious health effects." };
  if (aqi <= 300) return { id: 'very-unhealthy', text: "Very Unhealthy", advice: "Health alert: everyone may experience more serious health effects." };
  return { id: 'hazardous', text: "Hazardous", advice: "Health warnings of emergency conditions. The entire population is more likely to be affected." };
}

// --- Features ---

function useGeolocation(isInitial = false) {
  if (!navigator.geolocation) {
    if (!isInitial) alert("Geolocation is not supported by your browser.");
    getAQI("Pune");
    return;
  }

  showLoader(true);
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        const response = await fetch(`${PROXY_BASE}/api/feed/geo/${latitude}/${longitude}`);
        const data = await response.json();
        if (data.status === "ok" && data.data) {
          updateUI(data.data);
          fetchNearbyStations(latitude, longitude);
        } else {
          getAQI("Pune");
        }
      } catch (e) {
        console.error("Geolocation data fetch failed:", e);
        getAQI("Pune");
      } finally {
        showLoader(false);
      }
    },
    (error) => {
      console.warn("Geolocation denied:", error.message);
      if (!isInitial) alert("Location access denied. Showing results for Pune.");
      getAQI("Pune");
      showLoader(false);
    }
  );
}

// --- Data Visualization ---

function updatePollutants(iaqi) {
  const pollutants = ['pm25', 'pm10', 'no2', 'so2', 'o3', 'co'];
  pollutants.forEach(p => {
    const item = document.getElementById(`p_${p}`);
    if (!item) return;

    const val = iaqi[p] ? iaqi[p].v : '--';
    item.querySelector('.value').innerText = val;

    // Simple scale for progress bar (0-200)
    const progress = typeof val === 'number' ? Math.min((val / 200) * 100, 100) : 0;
    item.querySelector('.fill').style.width = `${progress}%`;
  });
}

function updateTrends(forecast) {
  if (!forecast || !forecast.pm25) return;

  const ctx = document.getElementById('trendChart').getContext('2d');
  const labels = forecast.pm25.map(d => d.day.split('-').slice(1).join('/'));
  const dataAvg = forecast.pm25.map(d => d.avg);
  const dataMax = forecast.pm25.map(d => d.max);

  if (trendChart) {
    trendChart.destroy();
  }

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Avg PM2.5',
        data: dataAvg,
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.1)',
        borderWidth: 3,
        fill: true,
        tension: 0.4
      }, {
        label: 'Max PM2.5',
        data: dataMax,
        borderColor: '#f87171',
        borderDash: [5, 5],
        borderWidth: 1,
        fill: false,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#94a3b8' } }
      },
      scales: {
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
        x: { grid: { display: false }, ticks: { color: '#94a3b8' } }
      }
    }
  });
}

async function fetchNearbyStations(lat, lon) {
  // Roughly 1 degree cover
  const bounds = `${lat - 0.5},${lon - 0.5},${lat + 0.5},${lon + 0.5}`;

  try {
    const response = await fetch(`${PROXY_BASE}/api/map/bounds?latlng=${bounds}`);
    const data = await response.json();
    if (data.status === "ok") {
      initMap(lat, lon, data.data);
    }
  } catch (e) {
    console.error("Map load failed", e);
  }
}

function initMap(lat, lon, stations) {
  if (!aqiMap) {
    aqiMap = L.map('map', {
      zoomControl: true,
      fadeAnimation: true
    }).setView([lat, lon], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(aqiMap);

    // Fix for map rendering issues in hidden/reshaped containers
    setTimeout(() => {
      aqiMap.invalidateSize();
    }, 200);
  } else {
    aqiMap.flyTo([lat, lon], 12, {
      duration: 1.5
    });
    // Re-invalidate size to be safe during updates
    aqiMap.invalidateSize();
  }

  // Clear old markers
  markers.forEach(m => aqiMap.removeLayer(m));
  markers = [];

  stations.forEach(s => {
    const color = s.aqi === "-" ? "#ccc" : getAQIColor(parseInt(s.aqi));
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: 12,
      fillColor: color,
      color: "#fff",
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8
    }).addTo(aqiMap);

    marker.bindPopup(`<b>${s.station.name}</b><br>AQI: ${s.aqi}`);
    markers.push(marker);
  });
}

// --- Utils ---

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function getAQIColor(aqi) {
  if (aqi <= 50) return "#00e676";
  if (aqi <= 100) return "#ffea00";
  if (aqi <= 150) return "#ff9100";
  if (aqi <= 200) return "#ff5252";
  if (aqi <= 300) return "#d500f9";
  return "#b71c1c";
}

function animateValue(id, start, end, duration) {
  const obj = document.getElementById(id);
  if (!obj) return;

  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    obj.innerHTML = Math.floor(progress * (end - start) + start);
    if (progress < 1) {
      window.requestAnimationFrame(step);
    }
  };
  window.requestAnimationFrame(step);
}

function showLoader(show) {
  const loader = document.getElementById('loader');
  if (loader) loader.classList.toggle('hidden', !show);
}

function toggleTheme() {
  const body = document.documentElement;
  const current = body.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  body.setAttribute('data-theme', next);

  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.setAttribute('data-lucide', next === 'dark' ? 'moon' : 'sun');
  }
  lucide.createIcons();
}

// --- Autocomplete Engine ---

function setupSearch() {
  const input = document.getElementById('cityInput');
  const list = document.getElementById('searchAutocomplete');

  // Debounced search handler
  const debouncedSearch = debounce(async (query) => {
    if (query.length < 2) {
      renderSuggestions(true); // show recents / favorites
      return;
    }
    await fetchSuggestions(query);
  }, 300);

  // Show recents/favorites when focused with empty input
  input.addEventListener('focus', () => {
    if (!input.value.trim()) {
      renderSuggestions(true);
    }
  });

  // Trigger search on each keystroke
  input.addEventListener('input', (e) => {
    selectedIndex = -1;
    debouncedSearch(e.target.value.trim());
  });

  // Keyboard navigation within the dropdown
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.autocomplete-item[role="option"]');
    if (!list.classList.contains('active') || items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection(items);
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      items[selectedIndex].click();
    } else if (e.key === 'Escape') {
      closeSuggestions();
      input.blur();
    }
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!input.closest('.search-box').contains(e.target)) {
      closeSuggestions();
    }
  });
}

async function fetchSuggestions(query) {
  const q = query.toLowerCase();

  // Return cached result immediately
  if (suggestionCache[q]) {
    currentSuggestions = suggestionCache[q];
    renderSuggestions(false);
    return;
  }

  try {
    const response = await fetch(
      `${PROXY_BASE}/api/search?keyword=${encodeURIComponent(query)}`
    );
    const data = await response.json();
    if (data.status === 'ok') {
      const results = data.data.slice(0, 5);
      suggestionCache[q] = results; // cache for session
      currentSuggestions = results;
      renderSuggestions(false);
    }
  } catch (e) {
    console.error('Suggestion fetch failed', e);
  }
}

function updateSelection(items) {
  const input = document.getElementById('cityInput');
  if (!input) return;

  items.forEach((item, index) => {
    const isSelected = index === selectedIndex;
    item.classList.toggle('selected', isSelected);
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    if (isSelected) {
      item.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', item.id);
    }
  });
}

function closeSuggestions() {
  const list = document.getElementById('searchAutocomplete');
  const input = document.getElementById('cityInput');
  if (list) list.classList.remove('active');
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  selectedIndex = -1;
}

function renderSuggestions(isInitial = true) {
  const list = document.getElementById('searchAutocomplete');
  const input = document.getElementById('cityInput');
  if (!list || !input) return;

  const query = input.value.trim();

  list.innerHTML = '';

  if (isInitial) {
    if (favorites.length === 0 && recentSearches.length === 0) {
      closeSuggestions();
      return;
    }
    if (favorites.length > 0) {
      appendSectionHeader(list, 'Favorites', 'star');
      favorites.forEach(city => {
        list.appendChild(createSearchItem(city, null, city, 'star'));
      });
    }
    if (recentSearches.length > 0) {
      appendSectionHeader(list, 'Recent Searches', 'history');
      recentSearches.forEach(city => {
        list.appendChild(createSearchItem(city, null, city, 'clock'));
      });
    }
  } else {
    if (currentSuggestions.length === 0) {
      list.innerHTML = `
        <div class="autocomplete-empty">
          <i data-lucide="search-x"></i>
          <span>No locations found for "${query}"</span>
        </div>`;
    } else {
      currentSuggestions.forEach((item, idx) => {
        const parts = item.station.name.split(',');
        const cityName = parts[0].trim();
        const country = parts.length > 1 ? parts[parts.length - 1].trim() : '';
        const itemEl = createSearchItem(cityName, country, `@${item.uid}`, 'map-pin', query, idx);
        list.appendChild(itemEl);
      });
    }
  }

  list.classList.add('active');
  input.setAttribute('aria-expanded', 'true');
  lucide.createIcons();
}

function appendSectionHeader(list, text) {
  const header = document.createElement('div');
  header.className = 'autocomplete-section-header';
  header.innerText = text;
  list.appendChild(header);
}

/**
 * Creates an autocomplete dropdown item.
 * @param {string} cityName  - primary label (city)
 * @param {string|null} country - secondary label (country), or null for recents/favs
 * @param {string} cityKey   - city or @uid used for getAQI()
 * @param {string} icon      - lucide icon name
 * @param {string} [query]   - original query for text highlighting
 * @param {number} [idx]     - numeric index for ARIA id
 */
function createSearchItem(cityName, country, cityKey, icon, query = '', idx = null) {
  const div = document.createElement('div');
  div.className = 'autocomplete-item';
  div.setAttribute('role', 'option');
  div.setAttribute('aria-selected', 'false');
  if (idx !== null) div.id = `autocomplete-opt-${idx}`;

  // Highlight query match in city name
  const highlightedCity = query
    ? cityName.replace(new RegExp(`(${query})`, 'gi'), '<mark>$1</mark>')
    : cityName;

  div.innerHTML = `
    <span class="autocomplete-icon"><i data-lucide="${icon}"></i></span>
    <span class="autocomplete-text">
      <span class="autocomplete-city">${highlightedCity}</span>
      ${country ? `<span class="autocomplete-country">${country}</span>` : ''}
    </span>
    ${idx !== null ? `<span class="autocomplete-aqi-badge" id="badge-opt-${idx}"></span>` : ''}
  `;

  div.addEventListener('click', () => {
    document.getElementById('cityInput').value = cityName;
    closeSuggestions();
    getAQI(cityKey);
  });

  div.addEventListener('mouseenter', () => {
    const items = document.querySelectorAll('#searchAutocomplete .autocomplete-item[role="option"]');
    selectedIndex = Array.from(items).indexOf(div);
    updateSelection(items);
  });

  return div;
}

function saveToRecents(city) {
  recentSearches = recentSearches.filter(c => c !== city);
  recentSearches.unshift(city);
  recentSearches = recentSearches.slice(0, 5);
  localStorage.setItem('aqi_recents', JSON.stringify(recentSearches));
}

function toggleFavorite() {
  if (!currentCityData) return;
  const city = currentCityData.city.name.split(',')[0];

  if (favorites.includes(city)) {
    favorites = favorites.filter(c => c !== city);
  } else {
    favorites.push(city);
  }

  localStorage.setItem('aqi_favorites', JSON.stringify(favorites));

  // Update UI immediately
  const favBtn = document.getElementById('favoriteBtn');
  favBtn.classList.toggle('active', favorites.includes(city));
  lucide.createIcons();
}

function showPollutantInfo(type) {
  const modal = document.getElementById('infoModal');
  const title = document.getElementById('modalTitle');
  const desc = document.getElementById('modalDescription');

  const info = {
    pm25: { title: "PM2.5 (Fine Particulate Matter)", desc: "Fine particles that are 2.5 micrometers or smaller in diameter. They can penetrate deep into the lungs and even enter the bloodstream. Major sources include vehicle exhaust, burning of coal or wood, and industrial processes." },
    pm10: { title: "PM10 (Coarse Particulate Matter)", desc: "Particulate matter that is 10 micrometers or smaller. These can be inhaled into the lungs. Sources include dust from roads, construction sites, landfills, and agriculture, as well as wildfires." },
    no2: { title: "NO2 (Nitrogen Dioxide)", desc: "A gaseous air pollutant composed of nitrogen and oxygen. It is primarily emitted from the burning of fuel in vehicles, power plants, and off-road equipment. It can irritate airways in the human respiratory system." },
    so2: { title: "SO2 (Sulfur Dioxide)", desc: "A toxic gas with a pungent, irritating smell. It is produced from the burning of fossil fuels (coal and oil) and from smelting mineral ores that contain sulfur. It can affect the respiratory system and lung function." },
    o3: { title: "O3 (Ground-Level Ozone)", desc: "Not emitted directly into the air, but created by chemical reactions between oxides of nitrogen (NOx) and volatile organic compounds (VOCs) in the presence of sunlight. It is the main ingredient in 'smog' and can trigger asthma." },
    co: { title: "CO (Carbon Monoxide)", desc: "A colorless, odorless gas that can be harmful when inhaled in large amounts. It is released when something is burned. The greatest sources of CO to outdoor air are cars, trucks and other vehicles or machinery that burn fossil fuels." }
  };

  if (info[type]) {
    title.innerText = info[type].title;
    desc.innerText = info[type].desc;
    modal.classList.add('active');
  }
}

function closeModal() {
  const modal = document.getElementById('infoModal');
  if (modal) modal.classList.remove('active');
}

// --- Share Feature ---

function openShareModal() {
  if (!currentCityData) return;
  const modal = document.getElementById('shareModal');
  if (modal) {
    modal.classList.add('active');

    // Reset buttons and preview
    document.getElementById('downloadBtn').disabled = true;
    document.getElementById('nativeShareBtn').disabled = true;
    document.getElementById('sharePreview').innerHTML = `
      <div class="preview-placeholder">
        <div class="spinner"></div>
        <p>Generating your card...</p>
      </div>
    `;

    // Trigger generation after modal animation (approx 300ms)
    // to keep the opening transition smooth
    setTimeout(generateShareCard, 400);
  }
}

function closeShareModal() {
  const modal = document.getElementById('shareModal');
  if (modal) modal.classList.remove('active');
}

/**
 * Helper to wrap text on canvas
 */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let lines = [];

  for (let n = 0; n < words.length; n++) {
    let testLine = line + words[n] + ' ';
    let metrics = ctx.measureText(testLine);
    let testWidth = metrics.width;
    if (testWidth > maxWidth && n > 0) {
      lines.push(line.trim());
      line = words[n] + ' ';
    } else {
      line = testLine;
    }
  }
  lines.push(line.trim());

  lines.forEach((l, i) => {
    ctx.fillText(l, x, y + (i * lineHeight));
  });

  return lines.length;
}

let isGenerating = false;

async function generateShareCard() {
  if (isGenerating) return;
  isGenerating = true;

  const canvas = document.getElementById('shareCanvas');
  const preview = document.getElementById('sharePreview');
  if (!canvas || !currentCityData) {
    isGenerating = false;
    return;
  }

  try {
    // 0. Wait for fonts to be ready
    await document.fonts.ready;

    const ctx = canvas.getContext('2d');
    const aqi = currentCityData.aqi;
    const category = getAQICategory(aqi);
    const cityName = currentCityData.city?.name ? currentCityData.city.name.split(',')[0] : "Unknown";
    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    // Use requestAnimationFrame to defer heavy drawing to the next frame
    requestAnimationFrame(() => {
      // Clear canvas
      ctx.clearRect(0, 0, 1080, 1080);

      // 1. Background Gradient based on AQI
      const gradient = ctx.createLinearGradient(0, 0, 1080, 1080);
      const color = getAQIColor(aqi);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, adjustColor(color, -70)); // Deepest depth
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1080, 1080);

      // 2. Add subtle glass effect center card
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.roundRect(80, 80, 920, 920, 60);
      ctx.fill();

      // 3. Header: City Name (with wrapping and scaling)
      ctx.fillStyle = 'white';
      ctx.textAlign = 'center';

      let cityFontSize = 90;
      if (cityName.length > 15) cityFontSize = 75;
      if (cityName.length > 25) cityFontSize = 60;
      if (cityName.length > 40) cityFontSize = 50;

      ctx.font = `bold ${cityFontSize}px Outfit, sans-serif`;

      const maxWidth = 800;
      const cityLineHeight = cityFontSize * 1.1;
      const startY = 220;
      const linesDrawn = wrapText(ctx, cityName.toUpperCase(), 540, startY, maxWidth, cityLineHeight);

      // 4. AQI Value (Adaptive Scaling)
      // Reduce font size as digits increase
      const aqiStr = aqi.toString();
      let aqiFontSize = 440;
      if (aqiStr.length === 2) aqiFontSize = 400;
      if (aqiStr.length >= 3) aqiFontSize = 340;

      const aqiY = 260 + (linesDrawn * cityLineHeight) + (aqiFontSize * 0.7);

      ctx.font = `bold ${aqiFontSize}px Outfit, sans-serif`;
      ctx.fillText(aqi, 540, aqiY);

      // "AQI" Label - smaller and better integrated
      const labelY = aqiY + (aqiFontSize * 0.15);
      ctx.font = '600 50px Outfit, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillText('AQI', 540, labelY);

      // 5. Category Badge - centered vertically between AQI and Footer
      const badgeY = labelY + 100;
      const badgeWidth = 600;
      const badgeHeight = 90;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.beginPath();
      ctx.roundRect(540 - (badgeWidth / 2), badgeY, badgeWidth, badgeHeight, 45);
      ctx.fill();

      ctx.fillStyle = 'white';
      ctx.font = 'bold 45px Outfit, sans-serif';
      ctx.fillText(category.text, 540, badgeY + (badgeHeight / 2) + 16);

      // 6. Footer Info
      const footerY = 960;
      ctx.font = '400 32px Outfit, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(dateStr, 540, footerY);

      ctx.font = 'bold 40px Outfit, sans-serif';
      ctx.fillStyle = 'white';
      ctx.fillText('AQI PRO', 540, footerY + 60);

      // Update Preview Image
      const dataUrl = canvas.toDataURL('image/png');
      preview.innerHTML = `<img src="${dataUrl}" alt="AQI Card Preview">`;

      // Enable buttons
      document.getElementById('downloadBtn').disabled = false;
      document.getElementById('nativeShareBtn').disabled = false;

      isGenerating = false;
    });
  } catch (error) {
    console.error("Card generation failed:", error);
    preview.innerHTML = `
      <div class="preview-error">
        <i data-lucide="alert-circle"></i>
        <p>Failed to generate card.</p>
        <button class="btn-primary" onclick="generateShareCard()">Retry</button>
      </div>
    `;
    lucide.createIcons();
    isGenerating = false;
  }
}

function downloadCard() {
  const canvas = document.getElementById('shareCanvas');
  if (!canvas) return;

  const link = document.createElement('a');
  const cityName = currentCityData?.city?.name?.split(',')[0] || 'city';
  link.download = `AQI_PRO_${cityName}_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

async function shareCard() {
  const canvas = document.getElementById('shareCanvas');
  if (!canvas) return;

  try {
    const dataUrl = canvas.toDataURL('image/png');
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'aqi_card.png', { type: 'image/png' });

    if (navigator.share) {
      await navigator.share({
        title: 'Air Quality Update',
        text: `Check out the air quality in ${currentCityData.city.name} via AQI PRO!`,
        files: [file]
      });
    } else {
      downloadCard();
    }
  } catch (err) {
    console.error('Sharing failed', err);
    downloadCard();
  }
}

// Utility to darken colors for gradient
function adjustColor(hex, amount) {
  let color = hex.replace('#', '');
  if (color.length === 3) color = color.split('').map(c => c + c).join('');

  const num = parseInt(color, 16);
  let r = (num >> 16) + amount;
  let g = ((num >> 8) & 0x00FF) + amount;
  let b = (num & 0x0000FF) + amount;

  r = Math.min(Math.max(0, r), 255);
  g = Math.min(Math.max(0, g), 255);
  b = Math.min(Math.max(0, b), 255);

  return `#${(g | (r << 8) | (b << 16)).toString(16).padStart(6, '0')}`;
}
