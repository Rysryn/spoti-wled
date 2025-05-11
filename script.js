document.addEventListener('DOMContentLoaded', () => {
    const loginButton = document.getElementById('login-button');
    const authSection = document.getElementById('auth-section');
    const mainContent = document.getElementById('main-content');

    const songNameEl = document.getElementById('song-name');
    const artistNameEl = document.getElementById('artist-name');
    const albumNameEl = document.getElementById('album-name');
    const albumArtEl = document.getElementById('album-art');
    const colorsContainer = document.getElementById('colors');

    const wledIpInput = document.getElementById('wled-ip');
    const sendColorButton = document.getElementById('send-color-to-wled');
    const wledStatusEl = document.getElementById('wled-status');

    const startAudioButton = document.getElementById('start-audio-button');
    const spectrumCanvas = document.getElementById('spectrum-canvas');
    const spectrumCtx = spectrumCanvas.getContext('2d');

    // --- Spotify Configuration ---
    // IMPORTANT: For Vercel, set these as Environment Variables if you build a backend component.
    // For pure client-side, CLIENT_ID is public. REDIRECT_URI must match Spotify Dev Dashboard.
    const CLIENT_ID = '2918e87bce0b42869013f3dbe2539d60'; // Replace with your Client ID
    const REDIRECT_URI = window.location.origin + window.location.pathname; // Or your specific Vercel URL / local URL
    const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
    const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
    const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';

    let accessToken = localStorage.getItem('spotify_access_token');
    let tokenExpiresAt = localStorage.getItem('spotify_token_expires_at');
    let currentAlbumArtUrl = '';
    let extractedColorsCache = [];

    // --- Web Audio API ---
    let audioContext;
    let analyser;
    let microphoneSource;
    let dataArray;
    let animationFrameId;
    let isAudioProcessing = false;


    // --- Utility Functions ---
    function generateRandomString(length) {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    async function generateCodeChallenge(codeVerifier) {
        const data = new TextEncoder().encode(codeVerifier);
        const digest = await window.crypto.subtle.digest('SHA-256', data);
        return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    // --- Spotify Authentication (PKCE Flow) ---
    loginButton.addEventListener('click', async () => {
        const codeVerifier = generateRandomString(128);
        localStorage.setItem('spotify_code_verifier', codeVerifier);
        const codeChallenge = await generateCodeChallenge(codeVerifier);
        const scope = 'user-read-currently-playing user-read-playback-state';

        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            response_type: 'code',
            redirect_uri: REDIRECT_URI,
            scope: scope,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge,
        });
        window.location.href = `${SPOTIFY_AUTH_URL}?${params.toString()}`;
    });

    async function handleCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const error = urlParams.get('error');

        if (error) {
            console.error('Spotify Auth Error:', error);
            alert('Spotify authentication failed.');
            return;
        }

        if (code) {
            const codeVerifier = localStorage.getItem('spotify_code_verifier');
            if (!codeVerifier) {
                console.error('Code verifier not found.');
                alert('Authentication session error. Please try logging in again.');
                return;
            }

            try {
                const response = await fetch(SPOTIFY_TOKEN_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        client_id: CLIENT_ID,
                        grant_type: 'authorization_code',
                        code: code,
                        redirect_uri: REDIRECT_URI,
                        code_verifier: codeVerifier,
                    }),
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(`Token exchange failed: ${errorData.error_description || response.statusText}`);
                }

                const data = await response.json();
                accessToken = data.access_token;
                const expiresIn = data.expires_in; // seconds
                tokenExpiresAt = Date.now() + expiresIn * 1000;

                localStorage.setItem('spotify_access_token', accessToken);
                localStorage.setItem('spotify_token_expires_at', tokenExpiresAt);
                localStorage.removeItem('spotify_code_verifier');

                // Clean URL
                window.history.replaceState({}, document.title, window.location.pathname);
                showMainContent();
                fetchCurrentlyPlaying();
            } catch (err) {
                console.error('Error getting token:', err);
                alert(`Error fetching Spotify token: ${err.message}`);
            }
        }
    }

    function isTokenValid() {
        return accessToken && tokenExpiresAt && Date.now() < tokenExpiresAt;
    }

    function showMainContent() {
        if (isTokenValid()) {
            authSection.style.display = 'none';
            mainContent.style.display = 'block';
        } else {
            authSection.style.display = 'block';
            mainContent.style.display = 'none';
            localStorage.removeItem('spotify_access_token');
            localStorage.removeItem('spotify_token_expires_at');
            accessToken = null;
            tokenExpiresAt = null;
        }
    }

    // --- Spotify API Calls ---
    async function fetchWebApi(endpoint, method = 'GET', body) {
        if (!isTokenValid()) {
            console.log('Access token expired or invalid. Please log in again.');
            showMainContent(); // This will show login button
            // Potentially try to refresh token here if implementing refresh token logic
            return null;
        }

        const res = await fetch(`${SPOTIFY_API_BASE_URL}${endpoint}`, {
            method: method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (res.status === 401) { // Unauthorized
            console.log('Token resulted in 401. Clearing token.');
            accessToken = null;
            tokenExpiresAt = null;
            localStorage.removeItem('spotify_access_token');
            localStorage.removeItem('spotify_token_expires_at');
            showMainContent();
            return null;
        }
        if (res.status === 204) { // No Content
            return null;
        }
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ message: res.statusText }));
            throw new Error(`Spotify API Error: ${errorData.error?.message || res.statusText}`);
        }
        return res.json();
    }

    async function fetchCurrentlyPlaying() {
        try {
            const data = await fetchWebApi('/me/player/currently-playing');
            if (data && data.item) {
                songNameEl.textContent = data.item.name;
                artistNameEl.textContent = data.item.artists.map(artist => artist.name).join(', ');
                albumNameEl.textContent = data.item.album.name;

                if (data.item.album.images && data.item.album.images.length > 0) {
                    const newAlbumArtUrl = data.item.album.images[0].url;
                    if (newAlbumArtUrl !== currentAlbumArtUrl) {
                        currentAlbumArtUrl = newAlbumArtUrl;
                        albumArtEl.src = currentAlbumArtUrl;
                        albumArtEl.style.display = 'block';
                        await extractAndDisplayColors(currentAlbumArtUrl);
                    }
                } else {
                    albumArtEl.style.display = 'none';
                    currentAlbumArtUrl = '';
                    colorsContainer.innerHTML = '<p>No album art available.</p>';
                }
            } else {
                songNameEl.textContent = 'N/A (Nothing playing or private session)';
                artistNameEl.textContent = 'N/A';
                albumNameEl.textContent = 'N/A';
                albumArtEl.style.display = 'none';
                currentAlbumArtUrl = '';
                colorsContainer.innerHTML = '';
            }
        } catch (error) {
            console.error('Error fetching currently playing:', error);
            songNameEl.textContent = `Error: ${error.message}`;
        }
    }

    // --- Color Extraction ---
    async function extractAndDisplayColors(imageUrl) {
        if (!imageUrl) return;
        colorsContainer.innerHTML = '<p>Extracting colors...</p>';
        try {
            // Need to use a CORS proxy if the image server doesn't allow direct access
            // For simplicity, we'll assume direct access works or use a proxy like `https://cors-anywhere.herokuapp.com/`
            // const proxyUrl = 'https://cors-anywhere.herokuapp.com/'; // Be mindful of proxy usage limits
            // const proxiedImageUrl = proxyUrl + imageUrl;
            // For many CDNs, direct access might work for extract-colors.js
            // If CORS issues persist, the image needs to be fetched server-side or via a reliable proxy.

            const img = new Image();
            img.crossOrigin = "Anonymous"; // Important for canvas-based extraction from different origins
            img.src = imageUrl; // Try direct first

            img.onload = async () => {
                 try {
                    const colors = await extractColors(img, { /* options */ });
                    extractedColorsCache = colors;
                    colorsContainer.innerHTML = '';
                    if (colors && colors.length > 0) {
                        colors.forEach(color => {
                            const colorBox = document.createElement('div');
                            colorBox.classList.add('color-box');
                            colorBox.style.backgroundColor = color.hex;
                            colorBox.title = color.hex;
                            colorsContainer.appendChild(colorBox);
                        });
                        // Automatically send the first prominent color to WLED if IP is set
                        if (wledIpInput.value.trim() && extractedColorsCache.length > 0) {
                           // sendPrimaryColorToWLED(extractedColorsCache[0]); // Optional: auto-send
                        }
                    } else {
                        colorsContainer.innerHTML = '<p>Could not extract colors.</p>';
                    }
                } catch (e) {
                    console.error('Error during color extraction from loaded image:', e);
                    colorsContainer.innerHTML = `<p>Error extracting colors (client-side). CORS might be an issue.</p>`;
                }
            };
            img.onerror = () => {
                console.error('Error loading image for color extraction. Likely CORS issue.');
                colorsContainer.innerHTML = `<p>Failed to load album art for color extraction. Check CORS policy of the image server.</p>`;
            }


        } catch (error) {
            console.error('Error extracting colors:', error);
            colorsContainer.innerHTML = `<p>Error extracting colors: ${error.message}</p>`;
        }
    }

    // --- WLED Integration ---
    async function sendWLEDCommand(ip, command) {
        if (!ip) {
            wledStatusEl.textContent = 'WLED IP not set.';
            wledStatusEl.style.color = 'red';
            return false;
        }
        try {
            const response = await fetch(`http://${ip}/json/state`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(command),
                mode: 'no-cors' // Usually WLED is on local network, no-cors might be needed if no proper CORS headers from WLED.
                               // For 'no-cors', you won't be able to read the response body directly, but the request will be sent.
                               // For better feedback, WLED should be configured for CORS or use a proxy.
            });

            // Due to 'no-cors', we can't reliably check response.ok or response.json()
            // We assume success if the fetch doesn't throw a network error.
            wledStatusEl.textContent = `Command sent to WLED (${new Date().toLocaleTimeString()}). Check WLED device.`;
            wledStatusEl.style.color = 'green';
            return true;

        } catch (error) {
            console.error('Error sending command to WLED:', error);
            wledStatusEl.textContent = `Error sending to WLED: ${error.message}`;
            wledStatusEl.style.color = 'red';
            return false;
        }
    }

    function sendPrimaryColorToWLED(color) {
        if (color && color.red != null && color.green != null && color.blue != null) {
            const wledIp = wledIpInput.value.trim();
            // WLED API uses [R, G, B] for solid color
            const command = { "seg": [{ "col": [[color.red, color.green, color.blue]] }] , "on": true};
            sendWLEDCommand(wledIp, command);
        } else {
            wledStatusEl.textContent = 'No valid color to send.';
            wledStatusEl.style.color = 'orange';
        }
    }

    sendColorButton.addEventListener('click', () => {
        if (extractedColorsCache.length > 0) {
            sendPrimaryColorToWLED(extractedColorsCache[0]); // Send the first (most dominant) color
        } else {
            wledStatusEl.textContent = 'No colors extracted yet.';
            wledStatusEl.style.color = 'orange';
        }
    });


    // --- Audio Spectrum Analysis (Microphone) ---
    async function setupAudioProcessing() {
        if (!isAudioProcessing) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                microphoneSource = audioContext.createMediaStreamSource(stream);
                analyser = audioContext.createAnalyser();
                analyser.fftSize = 256; // Adjust for more/less detail (powers of 2)
                const bufferLength = analyser.frequencyBinCount;
                dataArray = new Uint8Array(bufferLength);

                microphoneSource.connect(analyser);
                // Do not connect analyser to destination if you don't want to hear the microphone
                // analyser.connect(audioContext.destination);

                isAudioProcessing = true;
                startAudioButton.textContent = 'Stop Audio Analysis';
                drawSpectrum();
            } catch (err) {
                console.error('Error accessing microphone or setting up audio:', err);
                alert(`Could not access microphone: ${err.message}`);
                isAudioProcessing = false;
            }
        } else {
            stopAudioProcessing();
        }
    }

    function stopAudioProcessing() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
        if (microphoneSource) {
            microphoneSource.disconnect();
            microphoneSource.mediaStream.getTracks().forEach(track => track.stop()); // Stop microphone
        }
        if (audioContext && audioContext.state !== 'closed') {
            // audioContext.close(); // Closing and re-opening can be problematic. Better to just disconnect.
        }
        isAudioProcessing = false;
        startAudioButton.textContent = 'Start Audio Analysis';
        spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
    }


    function drawSpectrum() {
        if (!isAudioProcessing) return;

        animationFrameId = requestAnimationFrame(drawSpectrum);
        analyser.getByteFrequencyData(dataArray); // Fills dataArray with frequency data

        spectrumCtx.fillStyle = '#f0f0f0'; // Background
        spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);

        const barWidth = (spectrumCanvas.width / dataArray.length) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < dataArray.length; i++) {
            barHeight = dataArray[i]; // Value from 0 to 255

            // Simple color mapping (can be improved)
            const r = barHeight + (25 * (i / dataArray.length));
            const g = 250 * (i / dataArray.length);
            const b = 50;
            spectrumCtx.fillStyle = `rgb(${Math.min(255,r)},${Math.min(255,g)},${b})`;
            spectrumCtx.fillRect(x, spectrumCanvas.height - barHeight / 2, barWidth, barHeight / 2);

            x += barWidth + 1; // Add 1 for spacing
        }

        // Send spectrum data to WLED (example: send average bass level)
        const wledIp = wledIpInput.value.trim();
        if (wledIp && dataArray.length > 0) {
            // Example: average of first few bins for "bass" intensity (0-255)
            const bassBins = dataArray.slice(0, Math.floor(dataArray.length / 8));
            const avgBass = bassBins.reduce((sum, val) => sum + val, 0) / bassBins.length || 0;

            // Map this to WLED brightness or a specific segment
            // WLED API: {"seg": [{"bri": brightnessValue}]} or custom effect
            // This needs careful mapping to look good.
            // For real-time, UDP (E1.31/DDP) is better than many HTTP requests.
            // For simplicity, let's just log it here.
            // console.log(`Avg Bass for WLED: ${avgBass.toFixed(2)}`);
            // To actually send:
            // const command = { "seg": [{"bri": Math.round(avgBass) }] }; // Brightness of segment 0
            // sendWLEDCommand(wledIp, command); // This might be too frequent for HTTP POST

            // For WLED real-time effect control (e.g., "UDP Sound Sync" effect in WLED)
            // you'd typically send FFT data via UDP.
            // WLED JSON API can also accept arrays for segments, e.g., for a VU meter.
            // Example for a simple VU meter:
            // Let's say WLED has 16 LEDs, map dataArray (e.g., 64 bins) to 16 values.
            if (dataArray.length >= 16) { // Ensure enough data
                const numWledLeds = 16; // Example
                const wledLedValues = [];
                const binsPerLed = Math.floor(dataArray.length / numWledLeds);
                for (let j = 0; j < numWledLeds; j++) {
                    let sum = 0;
                    for (let k = 0; k < binsPerLed; k++) {
                        sum += dataArray[j * binsPerLed + k];
                    }
                    wledLedValues.push(Math.round(sum / binsPerLed / 255 * 100)); // % brightness
                }
                // This is a conceptual example. Sending full segment data via JSON API repeatedly can be slow.
                // Check WLED documentation for "realtime" JSON or UDP options for spectrum.
                // e.g. WLED JSON realtime: `{"seg": [{"i": [led1_val, led2_val, ...]}]}`
                // This part requires specific WLED setup and effect choices.
            }
        }
    }

    startAudioButton.addEventListener('click', setupAudioProcessing);


    // --- Initialization ---
    async function init() {
        await handleCallback(); // Check if we're coming back from Spotify login
        showMainContent();

        if (isTokenValid()) {
            fetchCurrentlyPlaying();
            setInterval(fetchCurrentlyPlaying, 15000); // Poll Spotify every 15 seconds
        }

        // Load WLED IP from local storage if available
        const savedWledIp = localStorage.getItem('wled_ip');
        if (savedWledIp) {
            wledIpInput.value = savedWledIp;
        }
        wledIpInput.addEventListener('change', () => {
            localStorage.setItem('wled_ip', wledIpInput.value.trim());
        });
    }

    init();
});