import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const API_KEY = process.env.WEATHER_API;

app.use(cors());

// Proxy endpoint for city feed
app.get('/api/feed/:city', async (req, res) => {
    const city = req.params.city;
    const url = city.startsWith('@')
        ? `https://api.waqi.info/feed/${city.substring(1)}/?token=${API_KEY}`
        : `https://api.waqi.info/feed/${encodeURIComponent(city)}/?token=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Proxy endpoint for geolocation
app.get('/api/feed/geo/:lat/:lon', async (req, res) => {
    const { lat, lon } = req.params;
    const url = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Proxy endpoint for search
app.get('/api/search', async (req, res) => {
    const keyword = req.query.keyword;
    const url = `https://api.waqi.info/search/?keyword=${encodeURIComponent(keyword)}&token=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Proxy endpoint for station map/bounds
app.get('/api/map/bounds', async (req, res) => {
    const latlng = req.query.latlng;
    const url = `https://api.waqi.info/map/bounds/?latlng=${latlng}&token=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Proxy endpoint for geocoding (Nominatim)
app.get('/api/geocode', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ status: 'error', message: 'Query parameter "q" is required' });
    }

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;

    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'AQI-Pro-App/1.0' }
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

export default app;
