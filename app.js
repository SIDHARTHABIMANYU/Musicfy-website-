const PROXY_URL = 'http://3.108.193.86:3001';
const BACKEND_URL = window.BACKEND_URL || PROXY_URL;
import { auth, db, signOut, onAuthStateChanged, doc, setDoc, getDoc, collection, addDoc, getDocs, deleteDoc } from './src/firebase.js';

// State Management
let songs = [];
let uploadedSongs = [];
let playlists = [];
let currentPlaylistId = null;
let currentMood = null;
let playHistory = [];
let queue = [];
let currentSong = null;
let currentUser = null;
let pendingUploads = [];

// IndexedDB for storing uploaded songs
let uploadDB = null;
const DB_NAME = 'MusicfyUploads';
const DB_VERSION = 1;
const STORE_NAME = 'songs';

// DOM Elements
const statusEl = document.getElementById('backend-status');
const refreshBtn = document.getElementById('refresh');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resultsGrid = document.getElementById('results-grid');

// =====================================================
// AUTHENTICATION
// =====================================================

const checkAuth = async () => {
  // We use setupAuthListener to handle the auth state globally
  setupAuthListener();
  return true;
};

const hideLoadingScreen = () => {
  const loadingScreen = document.getElementById('auth-loading');
  if (loadingScreen) {
    loadingScreen.style.opacity = '0';
    setTimeout(() => {
      loadingScreen.style.display = 'none';
    }, 300);
  }
};

const updateUserUI = (user) => {
  const avatar = document.querySelector('.avatar');
  const userInfoName = document.getElementById('user-name');
  const userInfoEmail = document.getElementById('user-email');
  const userAvatar = document.getElementById('user-avatar');

  if (user) {
    const userName = user.displayName || user.email.split('@')[0];
    const avatarUrl = user.photoURL;

    if (avatarUrl) {
      if (avatar) avatar.innerHTML = `<img src="${avatarUrl}" alt="${userName}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" />`;
      if (userAvatar) userAvatar.src = avatarUrl;
    } else {
      if (avatar) avatar.textContent = userName.charAt(0).toUpperCase();
    }

    if (userInfoName) userInfoName.textContent = userName;
    if (userInfoEmail) userInfoEmail.textContent = user.email;

    updateGreeting(userName);
  }
};

const handleLogout = async () => {
  try {
    await signOut(auth);
    window.location.href = '/login.html';
  } catch (error) {
    console.error('Logout error:', error);
  }
};

const setupAuthListener = () => {
  const loadingScreen = document.getElementById('auth-loading');

  // Safety timeout: Always hide loading screen after 5 seconds
  const safetyTimeout = setTimeout(() => {
    if (loadingScreen && loadingScreen.style.display !== 'none') {
      console.warn('Auth check taking long... hiding loading screen anyway.');
      loadingScreen.style.opacity = '0';
      setTimeout(() => loadingScreen.style.display = 'none', 300);
    }
  }, 5000);

  onAuthStateChanged(auth, (user) => {
    clearTimeout(safetyTimeout);
    if (user) {
      currentUser = user;
      updateUserUI(user);

      if (loadingScreen) {
        loadingScreen.style.opacity = '0';
        setTimeout(() => loadingScreen.style.display = 'none', 300);
      }

      loadPlaylists();
      loadHistory();

    } else {
      window.location.href = '/login.html';
    }
  });
};

// =====================================================
// INITIALIZATION
// =====================================================

// Update greeting based on time
const updateGreeting = (userName = 'User') => {
  const hour = new Date().getHours();
  const greetingEl = document.getElementById('greeting');
  let greeting = 'Good ';

  if (hour < 12) greeting += 'Morning';
  else if (hour < 17) greeting += 'Afternoon';
  else greeting += 'Evening';

  if (greetingEl) {
    greetingEl.innerHTML = `
      <h1>${greeting}, ${userName} 🎵</h1>
      <p>What do you want to listen to today?</p>
    `;
  }
};

// =====================================================
// BACKEND STATUS
// =====================================================

const setStatus = (ok, modelName) => {
  if (statusEl) {
    statusEl.textContent = ok ? 'Online' : 'Offline';
    statusEl.style.background = ok ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 71, 87, 0.1)';
    statusEl.style.borderColor = ok ? 'rgba(0, 255, 136, 0.3)' : 'rgba(255, 71, 87, 0.3)';
    statusEl.style.color = ok ? '#00ff88' : '#ff4757';
  }
};

const loadStatus = async () => {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      headers: { 'x-api-key': 'musicfy-secret-key-2026' }
    });
    if (!res.ok) throw new Error('offline');
    const data = await res.json();
    setStatus(true, data.model);
  } catch (err) {
    setStatus(false);
  }
};

// =====================================================
// SONGS MANAGEMENT
// =====================================================

const loadSongs = async () => {
  try {
    // Try local path first (from public folder)
    const res = await fetch('/songs/songs.json');
    if (!res.ok) throw new Error(`Failed to load songs: ${res.status}`);
    songs = await res.json();
    console.log('Loaded songs:', songs.length, 'songs available');
  } catch (err) {
    console.error('Error loading songs:', err);
    songs = [];
  }
};

const findSongByQuery = (query) => {
  const normalized = query.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Search local songs
  const localMatches = songs.filter(song => {
    const songNorm = song.toLowerCase().replace(/[^a-z0-9]/g, '');
    return songNorm.includes(normalized) || normalized.includes(songNorm);
  }).map(s => ({ type: 'local', data: s }));

  // Search uploaded songs
  const uploadedMatches = uploadedSongs.filter(song => {
    const nameNorm = (song.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const fileNorm = (song.fileName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return nameNorm.includes(normalized) || fileNorm.includes(normalized) || normalized.includes(nameNorm);
  }).map(s => ({ type: 'uploaded', data: s }));

  return [...localMatches, ...uploadedMatches];
};

const cleanSongTitle = (filename) => {
  return filename.replace('.mp3', '').replace(/_spotdown\.org/g, '').replace(/_/g, ' ');
};

// Download the currently playing song
const downloadCurrentSong = async () => {
  if (!currentSong) throw new Error('No song playing');

  let blob;
  let filename;

  if (currentSong.isUploaded) {
    // Get from IndexedDB using existing uploadDB
    if (!uploadDB) throw new Error('Upload database not initialized');

    const tx = uploadDB.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(currentSong.file);

    const song = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!song) throw new Error('Song not found in storage');
    blob = song.data;
    filename = song.name || `${currentSong.title}.mp3`;
  } else {
    // Fetch from local songs folder
    const response = await fetch(`/songs/${currentSong.file}`);
    blob = await response.blob();
    filename = currentSong.file;
  }

  // Create download link
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// =====================================================
// PLAYBACK
// =====================================================

const playSong = (songFile, songTitle) => {
  const audioPlayer = document.getElementById('audio-player');
  const audioElement = document.getElementById('song-audio');
  const titleElement = document.getElementById('song-title');
  const artistElement = document.getElementById('song-artist');

  // Set the song source from local public folder
  const songUrl = `/songs/${songFile}`;
  audioElement.src = songUrl;
  titleElement.textContent = songTitle;
  if (artistElement) artistElement.textContent = 'Local Library';
  currentSong = { file: songFile, title: songTitle };

  // Show player and add body padding
  audioPlayer.style.display = 'flex';
  document.body.classList.add('player-active');

  // Add to history
  addToHistory(songFile, songTitle);

  // Update right panel
  updateRightPanels(songFile, songTitle);

  // Auto-play
  audioElement.play().catch(e => console.error('Play error:', e));
};

const addToHistory = async (file, title) => {
  // Add to local state first for immediate UI update
  const existing = playHistory.findIndex(h => h.file === file);
  if (existing !== -1) {
    playHistory.splice(existing, 1);
  }
  playHistory.unshift({ file, title, time: new Date().toLocaleString() });
  playHistory = playHistory.slice(0, 20); // Keep last 20

  // Save to localStorage as backup
  localStorage.setItem('musicfy_history', JSON.stringify(playHistory));
  renderHistory();

  // Save to Firebase
  if (currentUser) {
    try {
      const historyRef = doc(db, 'users', currentUser.uid);
      await setDoc(historyRef, { history: playHistory }, { merge: true });
    } catch (error) {
      console.error('Error saving to Firebase history:', error);
    }
  }
};

const loadHistory = async () => {
  // First load from localStorage for instant display
  const saved = localStorage.getItem('musicfy_history');
  playHistory = saved ? JSON.parse(saved) : [];
  renderHistory();

  // Load from Firebase
  if (currentUser) {
    try {
      const historyRef = doc(db, 'users', currentUser.uid);
      const docSnap = await getDoc(historyRef);
      if (docSnap.exists() && docSnap.data().history) {
        playHistory = docSnap.data().history;
        localStorage.setItem('musicfy_history', JSON.stringify(playHistory));
        renderHistory();
      }
    } catch (error) {
      console.error('Error loading from Firebase history:', error);
    }
  }
};

const renderHistory = () => {
  const historyList = document.getElementById('history-list');
  if (!historyList) return;

  if (playHistory.length === 0) {
    historyList.innerHTML = '<p class="empty-state">No history yet. Start playing some music!</p>';
    return;
  }

  historyList.innerHTML = playHistory.map(item => `
    <div class="history-item" onclick="playSong('${item.file}', '${item.title.replace(/'/g, "\\'")}')">
      <div class="history-item-art">
        <img src="/thumbnail.jpg" alt="" style="width: 100%; height: 100%; object-fit: cover; border-radius: 10px;" />
      </div>
      <div class="history-item-info">
        <h4>${item.title}</h4>
        <span>${item.time}</span>
      </div>
    </div>
  `).join('');
};

// =====================================================
// RIGHT PANEL UPDATES
// =====================================================

const updateRightPanels = (songFile, songTitle) => {
  // Update Lyrics
  const lyricsContent = document.getElementById('lyrics-content');
  if (lyricsContent) {
    lyricsContent.innerHTML = `
      <div class="lyrics-line">🎵</div>
      <div class="lyrics-line active">${songTitle}</div>
      <div class="lyrics-line">♪ ♫ ♪</div>
      <div class="lyrics-line">Lyrics coming soon...</div>
      <div class="lyrics-line">Enjoy the music!</div>
    `;
  }

  // Update Related
  const relatedList = document.getElementById('related-list');
  if (relatedList && songs.length > 0) {
    const randomSongs = songs
      .filter(s => s !== songFile)
      .sort(() => Math.random() - 0.5)
      .slice(0, 5);

    if (randomSongs.length > 0) {
      relatedList.innerHTML = randomSongs.map(song => {
        const title = cleanSongTitle(song);
        return `<div class="related-item" onclick="playSong('${song}', '${title.replace(/'/g, "\\'")}')">${title}</div>`;
      }).join('');
    }
  }

  // Update Artist
  const artistContent = document.getElementById('artist-content');
  if (artistContent) {
    artistContent.innerHTML = `
      <div class="artist-avatar">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      </div>
      <h4 style="margin-bottom: 8px;">Unknown Artist</h4>
      <p>Playing: ${songTitle}</p>
    `;
  }

  // Update Queue
  const queueList = document.getElementById('queue-list');
  if (queueList) {
    if (queue.length === 0) {
      queueList.innerHTML = '<p class="empty-state">Queue is empty</p>';
    } else {
      queueList.innerHTML = queue.map((song, i) => `
        <div class="queue-item" onclick="playSong('${song.file}', '${song.title.replace(/'/g, "\\'")}')">${i + 1}. ${song.title}</div>
      `).join('');
    }
  }
};

// =====================================================
// SEARCH
// =====================================================

const displaySearchResults = (results) => {
  if (!resultsGrid) return;

  if (results.length === 0) {
    resultsGrid.innerHTML = '<div class="empty-state">No songs found. Try a different search term.</div>';
    return;
  }

  resultsGrid.innerHTML = results.map(item => {
    if (item.type === 'local') {
      const song = item.data;
      const title = cleanSongTitle(song);

      return `
        <div class="glass-card">
          <div class="song-thumbnail">
            <img src="/thumbnail.jpg" alt="${title}" onerror="this.style.display='none'; this.parentElement.classList.add('no-image');" />
            <div class="play-overlay" onclick="playSong('${song}', '${title.replace(/'/g, "\\'")}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>
          <p class="card-label">Local</p>
          <h3>${title}</h3>
          <span class="card-meta">MP3</span>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px;">
            <button class="song-btn" onclick="playSong('${song}', '${title.replace(/'/g, "\\'")}')">▶ Play</button>
            <button class="song-btn" onclick="showAddToPlaylistMenu('${song}', '${title.replace(/'/g, "\\'")}')">+ Add</button>
          </div>
        </div>
      `;
    } else {
      const song = item.data;
      return `
        <div class="glass-card">
          <div class="song-thumbnail">
            <img src="/thumbnail.jpg" alt="${song.name}" onerror="this.style.display='none'; this.parentElement.classList.add('no-image');" />
            <div class="play-overlay" onclick="playUploadedSong('${song.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>
          <p class="card-label">⬆️ Uploaded</p>
          <h3>${song.name}</h3>
          <span class="card-meta">${song.fileName}</span>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px;">
            <button class="song-btn" onclick="playUploadedSong('${song.id}')">▶ Play</button>
            <button class="song-btn" onclick="deleteUploadedSong('${song.id}')">🗑️ Delete</button>
          </div>
        </div>
      `;
    }
  }).join('');
};

const handleSearch = () => {
  const query = searchInput?.value.trim();
  if (!query) {
    displaySearchResults([]);
    return;
  }
  const results = findSongByQuery(query);
  displaySearchResults(results);

  // Show results section
  showSection('results');
};

// =====================================================
// PLAYLISTS MANAGEMENT
// =====================================================

const loadPlaylists = async () => {
  // First load from localStorage for instant display
  const saved = localStorage.getItem('musicfy_playlists');
  playlists = saved ? JSON.parse(saved) : [];
  renderPlaylists();
  renderPlaylistsManage();

  // Load from Firebase
  if (currentUser) {
    try {
      const playlistsQuery = await getDocs(collection(db, 'users', currentUser.uid, 'playlists'));
      if (!playlistsQuery.empty) {
        playlists = playlistsQuery.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        localStorage.setItem('musicfy_playlists', JSON.stringify(playlists));
        renderPlaylists();
        renderPlaylistsManage();
      }
    } catch (error) {
      console.error('Error loading from Firebase playlists:', error);
    }
  }
};

const savePlaylists = () => {
  localStorage.setItem('musicfy_playlists', JSON.stringify(playlists));
};

const renderPlaylists = () => {
  const listEl = document.getElementById('playlists-list');
  if (!listEl) return;

  if (playlists.length === 0) {
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = playlists.map(playlist => {
    const initial = playlist.name.charAt(0).toUpperCase();
    return `
      <div class="playlist-item" onclick="openPlaylistView('${playlist.id}')" title="${playlist.name}">
        ${initial}
        <button class="playlist-item-delete" onclick="event.stopPropagation(); deletePlaylist('${playlist.id}')">×</button>
      </div>
    `;
  }).join('');
};

const renderPlaylistsManage = () => {
  const grid = document.getElementById('playlists-manage-grid');
  if (!grid) return;

  if (playlists.length === 0) {
    grid.innerHTML = '<p class="empty-state">No playlists yet. Create one to get started!</p>';
    return;
  }

  grid.innerHTML = playlists.map(playlist => `
    <div class="manage-playlist-card" onclick="openPlaylistView('${playlist.id}')">
      <h4>${playlist.name}</h4>
      <span>${playlist.songs.length} songs</span>
    </div>
  `).join('');
};

const createPlaylist = async (name, description = '') => {
  const id = Date.now().toString();
  const playlist = { id, name, description, songs: [] };

  // Add to local state first
  playlists.push(playlist);
  savePlaylists();
  renderPlaylists();
  renderPlaylistsManage();

  // Save to Firebase
  if (currentUser) {
    try {
      await setDoc(doc(db, 'users', currentUser.uid, 'playlists', id), playlist);
    } catch (error) {
      console.error('Error saving playlist to Firebase:', error);
    }
  }

  return id;
};

const deletePlaylist = async (id) => {
  if (confirm('Delete this playlist?')) {
    // Remove from local state
    playlists = playlists.filter(p => p.id !== id);
    savePlaylists();
    renderPlaylists();
    renderPlaylistsManage();

    // Also delete from Firebase
    if (currentUser) {
      try {
        await deleteDoc(doc(db, 'users', currentUser.uid, 'playlists', id));
      } catch (error) {
        console.error('Error deleting playlist from Firebase:', error);
      }
    }
  }
};

const getPlaylistById = (id) => {
  return playlists.find(p => p.id === id);
};

const addSongToPlaylist = async (playlistId, songFile, songTitle) => {
  const playlist = getPlaylistById(playlistId);
  if (playlist && !playlist.songs.some(s => s.file === songFile)) {
    const song = { file: songFile, title: songTitle, added: new Date().toLocaleString() };
    playlist.songs.push(song);
    savePlaylists();

    // Save to Firebase
    if (currentUser) {
      try {
        await setDoc(doc(db, 'users', currentUser.uid, 'playlists', playlistId), playlist);
      } catch (error) {
        console.error('Error adding song to Firebase playlist:', error);
      }
    }

    return true;
  }
  return false;
};

const removeSongFromPlaylist = async (playlistId, songFile) => {
  const playlist = getPlaylistById(playlistId);
  if (playlist) {
    playlist.songs = playlist.songs.filter(s => s.file !== songFile);
    savePlaylists();

    // Remove from Firebase
    if (currentUser) {
      try {
        await setDoc(doc(db, 'users', currentUser.uid, 'playlists', playlistId), playlist);
      } catch (error) {
        console.error('Error removing song from Firebase playlist:', error);
      }
    }

    return true;
  }
  return false;
};

const openPlaylistView = (playlistId) => {
  currentPlaylistId = playlistId;
  const playlist = getPlaylistById(playlistId);

  const modal = document.getElementById('playlist-view-modal');
  const nameEl = document.getElementById('view-playlist-name');
  const songsList = document.getElementById('playlist-songs-list');

  nameEl.textContent = playlist.name;

  if (playlist.songs.length === 0) {
    songsList.innerHTML = '<div class="empty-state">No songs in this playlist yet</div>';
  } else {
    songsList.innerHTML = playlist.songs.map(song => `
      <div class="playlist-song-item">
        <div class="playlist-song-info">
          <h4>${song.title}</h4>
          <p>Added: ${song.added}</p>
        </div>
        <div class="song-action-btns">
          <button class="song-btn" onclick="playSong('${song.file}', '${song.title.replace(/'/g, "\\'")}')">▶ Play</button>
          <button class="song-btn remove" onclick="removeSongFromPlaylist('${playlistId}', '${song.file}'); openPlaylistView('${playlistId}');">✕</button>
        </div>
      </div>
    `).join('');
  }

  modal.style.display = 'flex';
};

const showAddToPlaylistMenu = (songFile, songTitle) => {
  if (playlists.length === 0) {
    alert('Create a playlist first!');
    return;
  }

  const menu = document.createElement('div');
  menu.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #2d2d2d;
    border: 1px solid rgba(156, 39, 176, 0.3);
    border-radius: 16px;
    padding: 20px;
    z-index: 1500;
    min-width: 300px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  `;

  const title = document.createElement('h3');
  title.textContent = 'Add to Playlist';
  title.style.cssText = 'margin-bottom: 16px; color: #e91e63; font-size: 16px;';
  menu.appendChild(title);

  playlists.forEach(playlist => {
    const btn = document.createElement('button');
    btn.textContent = playlist.name;
    btn.style.cssText = `
      width: 100%;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      color: #fff;
      padding: 12px 14px;
      border-radius: 10px;
      cursor: pointer;
      margin-bottom: 8px;
      text-align: left;
      transition: all 0.2s;
    `;

    btn.onmouseover = () => {
      btn.style.background = 'rgba(156, 39, 176, 0.15)';
      btn.style.borderColor = 'rgba(156, 39, 176, 0.4)';
    };
    btn.onmouseout = () => {
      btn.style.background = 'rgba(255,255,255,0.03)';
      btn.style.borderColor = 'rgba(255,255,255,0.08)';
    };

    btn.addEventListener('click', () => {
      if (addSongToPlaylist(playlist.id, songFile, songTitle)) {
        alert(`Added to ${playlist.name}`);
      } else {
        alert('Song already in this playlist');
      }
      document.body.removeChild(menu);
      document.body.removeChild(overlay);
    });

    menu.appendChild(btn);
  });

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(4px);
    z-index: 1499;
  `;

  overlay.addEventListener('click', () => {
    document.body.removeChild(menu);
    document.body.removeChild(overlay);
  });

  document.body.appendChild(overlay);
  document.body.appendChild(menu);
};

// Make functions global
window.playSong = playSong;
window.showAddToPlaylistMenu = showAddToPlaylistMenu;
window.openPlaylistView = openPlaylistView;
window.deletePlaylist = deletePlaylist;
window.removeSongFromPlaylist = removeSongFromPlaylist;

// =====================================================
// MOOD SELECTION
// =====================================================

const moodSongs = {
  happy: ['party', 'dance', 'fun', 'joy', 'celebrate'],
  sad: ['sad', 'pain', 'heart', 'cry', 'alone'],
  focus: ['study', 'calm', 'peaceful', 'concentration'],
  energy: ['workout', 'gym', 'power', 'energy', 'beat'],
  chill: ['relax', 'chill', 'soft', 'smooth', 'easy'],
  romantic: ['love', 'romance', 'heart', 'romantic', 'beautiful']
};

const selectMood = (mood) => {
  currentMood = mood;

  // Update UI
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mood === mood);
  });

  // Filter songs based on mood (simple keyword matching)
  const keywords = moodSongs[mood] || [];
  let moodFiltered = [];

  // Filter local songs
  if (keywords.length > 0 && songs.length > 0) {
    const localMatches = songs.filter(song => {
      const songLower = song.toLowerCase();
      return keywords.some(kw => songLower.includes(kw));
    }).map(s => ({ type: 'local', data: s }));
    moodFiltered = [...moodFiltered, ...localMatches];
  }

  // Filter uploaded songs
  if (keywords.length > 0 && uploadedSongs.length > 0) {
    const uploadMatches = uploadedSongs.filter(song => {
      const nameLower = (song.name || '').toLowerCase();
      return keywords.some(kw => nameLower.includes(kw));
    }).map(s => ({ type: 'uploaded', data: s }));
    moodFiltered = [...moodFiltered, ...uploadMatches];
  }

  // If no matches, show random mix
  if (moodFiltered.length === 0) {
    if (songs.length > 0) {
      const randomLocal = songs.sort(() => Math.random() - 0.5).slice(0, 4).map(s => ({ type: 'local', data: s }));
      moodFiltered = [...moodFiltered, ...randomLocal];
    }
    if (uploadedSongs.length > 0) {
      const randomUploaded = uploadedSongs.sort(() => Math.random() - 0.5).slice(0, 4).map(s => ({ type: 'uploaded', data: s }));
      moodFiltered = [...moodFiltered, ...randomUploaded];
    }
  }

  displaySearchResults(moodFiltered);
  showSection('results');
};

// =====================================================
// NAVIGATION
// =====================================================

const showSection = (section) => {
  // Hide all sections
  const sections = ['mood-section', 'search-section', 'auto-playlists-section', 'results-section', 'ai-dj-section', 'history-section', 'playlists-manage-section'];

  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Show relevant sections based on selection
  switch (section) {
    case 'ai-dj':
      document.getElementById('mood-section').style.display = 'block';
      document.getElementById('ai-dj-section').style.display = 'block';
      break;
    case 'mood':
      document.getElementById('mood-section').style.display = 'block';
      document.getElementById('auto-playlists-section').style.display = 'block';
      break;
    case 'history':
      document.getElementById('history-section').style.display = 'block';
      break;
    case 'playlists':
      document.getElementById('playlists-manage-section').style.display = 'block';
      break;
    case 'search':
      document.getElementById('search-section').style.display = 'block';
      document.getElementById('results-section').style.display = 'block';
      break;
    case 'results':
      document.getElementById('mood-section').style.display = 'block';
      document.getElementById('search-section').style.display = 'block';
      document.getElementById('results-section').style.display = 'block';
      break;
    default:
      document.getElementById('mood-section').style.display = 'block';
      document.getElementById('search-section').style.display = 'block';
      document.getElementById('auto-playlists-section').style.display = 'block';
    // results-section stays hidden until search
  }
};

const setupLeftNavigation = () => {
  // Brand logo click - go to home
  const brandLogo = document.getElementById('brand-logo');
  if (brandLogo) {
    brandLogo.addEventListener('click', () => {
      document.querySelectorAll('.left-sidebar .nav-icon-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('ai-dj-btn')?.classList.add('active');
      showSection('default');
    });
  }

  const navButtons = {
    'ai-dj-btn': 'ai-dj',
    'mood-btn': 'mood',
    'history-btn': 'history',
    'playlists-btn': 'playlists',
    'search-nav-btn': 'search'
  };

  Object.entries(navButtons).forEach(([btnId, section]) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('click', () => {
        // Update active state
        document.querySelectorAll('.left-sidebar .nav-icon-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        showSection(section);
      });
    }
  });
};

const setupRightNavigation = () => {
  const panels = ['lyrics', 'related', 'artist', 'queue'];

  panels.forEach(panel => {
    const btn = document.getElementById(`${panel}-btn`);
    if (btn) {
      btn.addEventListener('click', () => {
        // Update active state
        document.querySelectorAll('.right-sidebar .nav-icon-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Show correct panel
        panels.forEach(p => {
          const panelEl = document.getElementById(`${p}-panel`);
          if (panelEl) {
            panelEl.style.display = p === panel ? 'block' : 'none';
          }
        });
      });
    }
  });
};

// =====================================================
// MODAL CONTROLS
// =====================================================

const setupModals = () => {
  const playlistModal = document.getElementById('playlist-modal');
  const viewModal = document.getElementById('playlist-view-modal');
  const addPlaylistBtn = document.querySelector('.add-playlist-btn');
  const createBtn = document.getElementById('create-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const modalClose = document.getElementById('modal-close');
  const playlistNameInput = document.getElementById('playlist-name');
  const playlistDescInput = document.getElementById('playlist-desc');
  const closeViewBtn = document.getElementById('close-view-btn');
  const viewModalClose = document.getElementById('view-modal-close');
  const deletePlaylistBtn = document.getElementById('delete-playlist-btn');

  if (addPlaylistBtn) {
    addPlaylistBtn.addEventListener('click', () => {
      playlistNameInput.value = '';
      playlistDescInput.value = '';
      playlistModal.style.display = 'flex';
    });
  }

  if (createBtn) {
    createBtn.addEventListener('click', () => {
      const name = playlistNameInput.value.trim();
      if (name) {
        createPlaylist(name, playlistDescInput.value);
        playlistModal.style.display = 'none';
      }
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      playlistModal.style.display = 'none';
    });
  }

  if (modalClose) {
    modalClose.addEventListener('click', () => {
      playlistModal.style.display = 'none';
    });
  }

  if (closeViewBtn) {
    closeViewBtn.addEventListener('click', () => {
      viewModal.style.display = 'none';
      currentPlaylistId = null;
    });
  }

  if (viewModalClose) {
    viewModalClose.addEventListener('click', () => {
      viewModal.style.display = 'none';
      currentPlaylistId = null;
    });
  }

  if (deletePlaylistBtn) {
    deletePlaylistBtn.addEventListener('click', () => {
      if (currentPlaylistId) {
        deletePlaylist(currentPlaylistId);
        viewModal.style.display = 'none';
        currentPlaylistId = null;
      }
    });
  }

  // Close modals on background click
  if (playlistModal) {
    playlistModal.addEventListener('click', (e) => {
      if (e.target === playlistModal) {
        playlistModal.style.display = 'none';
      }
    });
  }

  if (viewModal) {
    viewModal.addEventListener('click', (e) => {
      if (e.target === viewModal) {
        viewModal.style.display = 'none';
        currentPlaylistId = null;
      }
    });
  }
};

// =====================================================
// CHAT WIDGET
// =====================================================

const setupChat = () => {
  const chatToggle = document.getElementById('chat-toggle');
  const chatWindow = document.getElementById('chat-window');
  const chatClose = document.getElementById('chat-close');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatMessages = document.getElementById('chat-messages');

  let isChatOpen = false;

  if (chatToggle) {
    chatToggle.addEventListener('click', () => {
      isChatOpen = !isChatOpen;
      if (chatWindow) {
        chatWindow.classList.toggle('open', isChatOpen);
      }
    });
  }

  if (chatClose) {
    chatClose.addEventListener('click', () => {
      isChatOpen = false;
      if (chatWindow) {
        chatWindow.classList.remove('open');
      }
    });
  }

  const addChatMessage = (message, isUser = false) => {
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
      background: ${isUser ? 'linear-gradient(135deg, #9c27b0, #e91e63)' : 'rgba(255, 255, 255, 0.05)'};
      padding: 12px 16px;
      border-radius: 16px;
      color: ${isUser ? '#ffffff' : '#b0b0b0'};
      font-size: 13px;
      align-self: ${isUser ? 'flex-end' : 'flex-start'};
      max-width: 85%;
      font-weight: ${isUser ? '600' : '400'};
    `;
    msgDiv.textContent = message;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };

  // ── Typing Indicator ──
  const showTyping = () => {
    const t = document.createElement('div');
    t.id = 'chat-typing-indicator';
    t.style.cssText = 'background:rgba(255,255,255,0.05);padding:10px 14px;border-radius:14px;display:inline-flex;gap:5px;align-items:center;margin-bottom:4px;';
    t.innerHTML = `<span style="width:7px;height:7px;border-radius:50%;background:#9c27b0;animation:chat-dot 1.2s infinite 0s"></span><span style="width:7px;height:7px;border-radius:50%;background:#9c27b0;animation:chat-dot 1.2s infinite 0.2s"></span><span style="width:7px;height:7px;border-radius:50%;background:#9c27b0;animation:chat-dot 1.2s infinite 0.4s"></span>`;
    chatMessages.appendChild(t);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };
  const hideTyping = () => { const t = document.getElementById('chat-typing-indicator'); if (t) t.remove(); };

  // ── Inject typing animation CSS once ──
  if (!document.getElementById('chat-dot-style')) {
    const s = document.createElement('style');
    s.id = 'chat-dot-style';
    s.textContent = '@keyframes chat-dot{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}';
    document.head.appendChild(s);
  }

  let isChatBusy = false;

  const handleChatMessage = async () => {
    if (isChatBusy) return;
    const message = chatInput.value.trim();
    if (!message) return;

    chatInput.value = '';
    isChatBusy = true;
    if (chatSend) chatSend.disabled = true;

    addChatMessage(message, true);
    showTyping();

    try {
      const res = await fetch('http://3.108.193.86:3001/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'musicfy-secret-key-2026'
        },
        mode: 'cors',
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(30000),
      });
      hideTyping();
      if (!res.ok) throw new Error('backend-error');
      const data = await res.json();
      const replyText = data.reply || '';

      // Intent Extraction Logic (Same as chatbot)
      const userText = replyText.toLowerCase() + " " + message.toLowerCase();
      let status = 'unknown_intent';
      let songData = {};

      if (userText.includes('play')) {
        status = 'playing';
        const query = message.toLowerCase().replace(/play/i, '').trim();
        songData = { song: query };
      } else if (userText.includes('pause')) {
        status = 'paused';
      } else if (userText.includes('stop')) {
        status = 'stopped';
      } else if (userText.includes('resume')) {
        status = 'resumed';
      } else if (userText.includes('search')) {
        status = 'searching';
        const query = message.toLowerCase().replace(/search/i, '').trim();
        songData = { song: query };
      } else if (userText.includes('download')) {
        status = 'downloading';
      }

      // Execute the action!
      if (status !== 'unknown_intent') {
        const aiResponse = { status, data: songData, message: replyText };
        // We need a small helper to handle these here
        handleAiAction(aiResponse);
      }

      addChatMessage(`🤖 ${replyText}`);
    } catch (err) {
      hideTyping();
      addChatMessage('⚠️ Error connecting to AI: ' + err.message);
    } finally {
      isChatBusy = false;
      if (chatSend) chatSend.disabled = false;
      if (chatInput) chatInput.focus();
    }
  };

  const handleAiAction = (response) => {
    const status = (response.status || '').toLowerCase();
    const data = response.data || {};
    const audio = document.getElementById('song-audio');
    const playPauseBtn = document.getElementById('play-pause-btn');

    if (status === 'playing') {
      const query = data.song || '';
      const matches = findSongByQuery(query);
      if (matches.length > 0) {
        const first = matches[0];
        if (first.type === 'local') playSong(first.data, cleanSongTitle(first.data));
        else playUploadedSong(first.data.id);
      }
    } else if (status === 'searching') {
      const query = data.song || '';
      searchInput.value = query;
      handleSearch();
    } else if (status === 'paused') {
      if (audio) audio.pause();
    } else if (status === 'resumed' || status === 'stop_pause') {
      if (audio) audio.play();
    } else if (status === 'stopped') {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    } else if (status === 'downloading') {
      downloadCurrentSong().catch(err => console.error('Download error:', err));
    }
  };

  if (chatSend) chatSend.addEventListener('click', handleChatMessage);
  if (chatInput) chatInput.addEventListener('keypress', e => { if (e.key === 'Enter') handleChatMessage(); });
};


// =====================================================
// AUTO-GENERATED PLAYLISTS
// =====================================================

const setupAutoPlaylists = () => {
  const playlistCards = document.querySelectorAll('.playlist-card');

  playlistCards.forEach(card => {
    card.addEventListener('click', () => {
      const type = card.dataset.type;
      let filtered = [];

      switch (type) {
        case 'morning':
          filtered = songs.filter(s => s.toLowerCase().includes('morning') || s.toLowerCase().includes('fresh')).slice(0, 10);
          break;
        case 'workout':
          filtered = songs.filter(s => s.toLowerCase().includes('energy') || s.toLowerCase().includes('beat') || s.toLowerCase().includes('power')).slice(0, 10);
          break;
        case 'chill':
          filtered = songs.filter(s => s.toLowerCase().includes('chill') || s.toLowerCase().includes('relax') || s.toLowerCase().includes('soft')).slice(0, 10);
          break;
        case 'focus':
          filtered = songs.filter(s => s.toLowerCase().includes('study') || s.toLowerCase().includes('calm') || s.toLowerCase().includes('peace')).slice(0, 10);
          break;
      }

      // Convert local to objects
      let results = filtered.map(s => ({ type: 'local', data: s }));

      // Add uploaded songs
      if (uploadedSongs.length > 0) {
        const uploadedMatches = uploadedSongs.slice(0, 5).map(s => ({ type: 'uploaded', data: s }));
        results = [...results, ...uploadedMatches];
      }

      // If no matches, get random mix
      if (results.length === 0) {
        if (songs.length > 0) {
          const randomLocal = songs.sort(() => Math.random() - 0.5).slice(0, 4).map(s => ({ type: 'local', data: s }));
          results = [...results, ...randomLocal];
        }
        if (uploadedSongs.length > 0) {
          const randomUpload = uploadedSongs.sort(() => Math.random() - 0.5).slice(0, 4).map(s => ({ type: 'uploaded', data: s }));
          results = [...results, ...randomUpload];
        }
      }

      displaySearchResults(results);
      showSection('results');
    });
  });
};

// =====================================================
// AI DJ
// =====================================================

const setupAiDj = () => {
  const startDjBtn = document.getElementById('start-dj-btn');

  if (startDjBtn) {
    startDjBtn.addEventListener('click', () => {
      if (songs.length === 0) {
        alert('No songs available. Please add some songs first!');
        return;
      }

      // Create a random DJ mix
      const djMix = songs.sort(() => Math.random() - 0.5).slice(0, 10);

      // Add to queue
      queue = djMix.map(song => ({
        file: song,
        title: cleanSongTitle(song)
      }));

      // Play first song
      if (queue.length > 0) {
        const first = queue.shift();
        playSong(first.file, first.title);
      }

      updateRightPanels('', '');
    });
  }
};

// =====================================================
// MOOD BUTTONS
// =====================================================

const setupMoodButtons = () => {
  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mood = btn.dataset.mood;
      selectMood(mood);
    });
  });
};

// =====================================================
// EVENT LISTENERS
// =====================================================

const setupEventListeners = () => {
  if (searchBtn) {
    searchBtn.addEventListener('click', handleSearch);
  }

  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSearch();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadStatus);
  }
};

// =====================================================
// PLAYER CONTROLS (SPOTIFY-STYLE)
// =====================================================

const setupPlayerControls = () => {
  const audio = document.getElementById('song-audio');
  const playPauseBtn = document.getElementById('play-pause-btn');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const shuffleBtn = document.getElementById('shuffle-btn');
  const repeatBtn = document.getElementById('repeat-btn');
  const progressSlider = document.getElementById('progress-slider');
  const progressFill = document.getElementById('progress-fill');
  const topProgressSlider = document.getElementById('top-progress-slider');
  const topProgressFill = document.getElementById('top-progress-fill');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');
  const volumeSlider = document.getElementById('volume-slider');
  const volumeFill = document.getElementById('volume-fill');
  const volumeBtn = document.getElementById('volume-btn');
  const likeBtn = document.getElementById('like-btn');

  if (!audio) return;

  let isShuffled = false;
  let repeatMode = 0; // 0: off, 1: all, 2: one
  let previousVolume = 1;

  // Format time helper
  const formatTime = (seconds) => {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Play/Pause toggle
  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => {
      if (audio.paused) {
        audio.play();
      } else {
        audio.pause();
      }
    });
  }

  // Update play/pause button icons
  audio.addEventListener('play', () => {
    const playIcon = playPauseBtn?.querySelector('.play-icon');
    const pauseIcon = playPauseBtn?.querySelector('.pause-icon');
    if (playIcon) playIcon.style.display = 'none';
    if (pauseIcon) pauseIcon.style.display = 'block';
    document.body.classList.add('player-active');
  });

  audio.addEventListener('pause', () => {
    const playIcon = playPauseBtn?.querySelector('.play-icon');
    const pauseIcon = playPauseBtn?.querySelector('.pause-icon');
    if (playIcon) playIcon.style.display = 'block';
    if (pauseIcon) pauseIcon.style.display = 'none';
  });

  // Progress bar updates
  audio.addEventListener('timeupdate', () => {
    if (!isNaN(audio.duration)) {
      const progress = (audio.currentTime / audio.duration) * 100;
      if (progressFill) progressFill.style.width = `${progress}%`;
      if (progressSlider) progressSlider.value = progress;
      if (topProgressFill) topProgressFill.style.width = `${progress}%`;
      if (topProgressSlider) topProgressSlider.value = progress;
      if (timeCurrent) timeCurrent.textContent = formatTime(audio.currentTime);
    }
  });

  audio.addEventListener('loadedmetadata', () => {
    if (timeTotal) timeTotal.textContent = formatTime(audio.duration);
  });

  // Seek functionality
  if (progressSlider) {
    progressSlider.addEventListener('input', (e) => {
      const seekTime = (e.target.value / 100) * audio.duration;
      audio.currentTime = seekTime;
    });
  }

  // Top progress bar seek
  if (topProgressSlider) {
    topProgressSlider.addEventListener('input', (e) => {
      const seekTime = (e.target.value / 100) * audio.duration;
      audio.currentTime = seekTime;
    });
  }

  // Volume control
  if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
      const volume = e.target.value / 100;
      audio.volume = volume;
      if (volumeFill) volumeFill.style.width = `${e.target.value}%`;
      updateVolumeIcon(volume);
    });
  }

  const updateVolumeIcon = (volume) => {
    const volumeHigh = volumeBtn?.querySelector('.volume-high');
    const volumeMuted = volumeBtn?.querySelector('.volume-muted');
    if (volume === 0) {
      if (volumeHigh) volumeHigh.style.display = 'none';
      if (volumeMuted) volumeMuted.style.display = 'block';
    } else {
      if (volumeHigh) volumeHigh.style.display = 'block';
      if (volumeMuted) volumeMuted.style.display = 'none';
    }
  };

  // Mute toggle
  if (volumeBtn) {
    volumeBtn.addEventListener('click', () => {
      if (audio.volume > 0) {
        previousVolume = audio.volume;
        audio.volume = 0;
        if (volumeSlider) volumeSlider.value = 0;
        if (volumeFill) volumeFill.style.width = '0%';
      } else {
        audio.volume = previousVolume;
        if (volumeSlider) volumeSlider.value = previousVolume * 100;
        if (volumeFill) volumeFill.style.width = `${previousVolume * 100}%`;
      }
      updateVolumeIcon(audio.volume);
    });
  }

  // Previous/Next track
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      // If more than 3 seconds into song, restart; otherwise play previous
      if (audio.currentTime > 3) {
        audio.currentTime = 0;
      } else if (playHistory.length > 1) {
        const prevSong = playHistory[1];
        if (prevSong) playSong(prevSong.file, prevSong.title);
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      // Play random or next from filtered songs
      const availableSongs = songs.filter(s => s !== currentSong?.file);
      if (availableSongs.length > 0) {
        const nextSong = isShuffled
          ? availableSongs[Math.floor(Math.random() * availableSongs.length)]
          : availableSongs[0];
        const title = cleanSongTitle(nextSong);
        playSong(nextSong, title);
      }
    });
  }

  // Shuffle toggle
  if (shuffleBtn) {
    shuffleBtn.addEventListener('click', () => {
      isShuffled = !isShuffled;
      shuffleBtn.classList.toggle('active', isShuffled);
    });
  }

  // Repeat toggle
  if (repeatBtn) {
    repeatBtn.addEventListener('click', () => {
      repeatMode = (repeatMode + 1) % 3;
      repeatBtn.classList.toggle('active', repeatMode > 0);
      audio.loop = repeatMode === 2;
    });
  }

  // Auto-play next on end
  audio.addEventListener('ended', () => {
    if (repeatMode === 2) {
      audio.play();
    } else if (repeatMode === 1 || isShuffled) {
      nextBtn?.click();
    }
  });

  // Like button toggle
  if (likeBtn) {
    likeBtn.addEventListener('click', () => {
      likeBtn.classList.toggle('liked');
    });
  }

  console.log('🎮 Player controls initialized');
};

// =====================================================
// RESIZABLE SIDEBARS
// =====================================================

const setupResizableSidebars = () => {
  const layout = document.querySelector('.layout');
  const leftSidebar = document.getElementById('left-sidebar');
  const rightSidebar = document.getElementById('right-sidebar');
  const leftHandle = document.getElementById('left-resize-handle');
  const rightHandle = document.getElementById('right-resize-handle');

  if (!leftSidebar || !rightSidebar || !leftHandle || !rightHandle) return;

  const MIN_WIDTH = 60;
  const MAX_WIDTH = 280;
  const EXPANDED_THRESHOLD = 140;

  let isResizing = false;
  let currentHandle = null;
  let startX = 0;
  let startWidth = 0;

  // Load saved widths from localStorage
  const savedLeftWidth = localStorage.getItem('musicfy_left_sidebar_width');
  const savedRightWidth = localStorage.getItem('musicfy_right_sidebar_width');

  if (savedLeftWidth) {
    const width = parseInt(savedLeftWidth);
    layout.style.setProperty('--left-sidebar-width', `${width}px`);
    if (width >= EXPANDED_THRESHOLD) leftSidebar.classList.add('expanded');
  }

  if (savedRightWidth) {
    const width = parseInt(savedRightWidth);
    layout.style.setProperty('--right-sidebar-width', `${width}px`);
    if (width >= EXPANDED_THRESHOLD) rightSidebar.classList.add('expanded');
  }

  const startResize = (e, handle, sidebar, isLeft) => {
    e.preventDefault();
    isResizing = true;
    currentHandle = handle;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;

    handle.classList.add('dragging');
    document.body.classList.add('resizing');

    const onMouseMove = (e) => {
      if (!isResizing) return;

      const diff = isLeft ? (e.clientX - startX) : (startX - e.clientX);
      let newWidth = startWidth + diff;

      // Clamp width
      newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));

      // Update CSS variable
      const varName = isLeft ? '--left-sidebar-width' : '--right-sidebar-width';
      layout.style.setProperty(varName, `${newWidth}px`);

      // Toggle expanded class
      if (newWidth >= EXPANDED_THRESHOLD) {
        sidebar.classList.add('expanded');
      } else {
        sidebar.classList.remove('expanded');
      }
    };

    const onMouseUp = () => {
      if (!isResizing) return;

      isResizing = false;
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');

      // Save width to localStorage
      const currentWidth = sidebar.offsetWidth;
      const key = isLeft ? 'musicfy_left_sidebar_width' : 'musicfy_right_sidebar_width';
      localStorage.setItem(key, currentWidth.toString());

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // Setup left handle
  leftHandle.addEventListener('mousedown', (e) => {
    startResize(e, leftHandle, leftSidebar, true);
  });

  // Setup right handle
  rightHandle.addEventListener('mousedown', (e) => {
    startResize(e, rightHandle, rightSidebar, false);
  });

  // Double-click to toggle between min and expanded
  leftHandle.addEventListener('dblclick', () => {
    const currentWidth = leftSidebar.offsetWidth;
    const newWidth = currentWidth < EXPANDED_THRESHOLD ? 200 : MIN_WIDTH;
    layout.style.setProperty('--left-sidebar-width', `${newWidth}px`);
    leftSidebar.classList.toggle('expanded', newWidth >= EXPANDED_THRESHOLD);
    localStorage.setItem('musicfy_left_sidebar_width', newWidth.toString());
  });

  rightHandle.addEventListener('dblclick', () => {
    const currentWidth = rightSidebar.offsetWidth;
    const newWidth = currentWidth < EXPANDED_THRESHOLD ? 200 : MIN_WIDTH;
    layout.style.setProperty('--right-sidebar-width', `${newWidth}px`);
    rightSidebar.classList.toggle('expanded', newWidth >= EXPANDED_THRESHOLD);
    localStorage.setItem('musicfy_right_sidebar_width', newWidth.toString());
  });

  console.log('↔️ Resizable sidebars initialized');
};

// =====================================================
// UPLOAD FUNCTIONALITY
// =====================================================

// Initialize IndexedDB for uploaded songs
const initUploadDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('Failed to open IndexedDB');
      reject(request.error);
    };

    request.onsuccess = () => {
      uploadDB = request.result;
      console.log('📦 IndexedDB initialized');
      resolve(uploadDB);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('uploadedAt', 'uploadedAt', { unique: false });
      }
    };
  });
};

// Load uploaded songs from IndexedDB
const loadUploadedSongs = async () => {
  if (!uploadDB) return [];

  return new Promise((resolve, reject) => {
    const transaction = uploadDB.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      uploadedSongs = request.result || [];
      console.log(`📁 Loaded ${uploadedSongs.length} uploaded songs`);
      renderUploadedSongs();
      resolve(uploadedSongs);
    };

    request.onerror = () => {
      console.error('Failed to load uploaded songs');
      reject(request.error);
    };
  });
};

// Save song to IndexedDB
const saveSongToDB = (songData) => {
  return new Promise((resolve, reject) => {
    if (!uploadDB) {
      reject(new Error('Database not initialized'));
      return;
    }

    const transaction = uploadDB.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(songData);

    request.onsuccess = () => {
      console.log(`✅ Saved: ${songData.name}`);
      resolve(songData);
    };

    request.onerror = () => {
      console.error(`Failed to save: ${songData.name}`);
      reject(request.error);
    };
  });
};

// Delete song from IndexedDB
const deleteSongFromDB = (songId) => {
  return new Promise((resolve, reject) => {
    if (!uploadDB) {
      reject(new Error('Database not initialized'));
      return;
    }

    const transaction = uploadDB.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(songId);

    request.onsuccess = () => {
      console.log(`🗑️ Deleted song: ${songId}`);
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
};

// Format file size
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Render pending uploads list
const renderPendingUploads = () => {
  const listEl = document.getElementById('uploaded-files-list');
  const confirmBtn = document.getElementById('upload-confirm-btn');

  if (!listEl) return;

  if (pendingUploads.length === 0) {
    listEl.innerHTML = '';
    if (confirmBtn) confirmBtn.disabled = true;
    return;
  }

  if (confirmBtn) confirmBtn.disabled = false;

  listEl.innerHTML = pendingUploads.map((file, index) => `
    <div class="uploaded-file-item">
      <div class="uploaded-file-info">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        <span class="file-name">${file.name}</span>
        <span class="file-size">${formatFileSize(file.size)}</span>
      </div>
      <button class="remove-file-btn" onclick="removePendingUpload(${index})">×</button>
    </div>
  `).join('');
};

// Remove pending upload
const removePendingUpload = (index) => {
  pendingUploads.splice(index, 1);
  renderPendingUploads();
};
window.removePendingUpload = removePendingUpload;

// Handle file selection
const handleFileSelect = (files) => {
  const audioFiles = Array.from(files).filter(file =>
    file.type.startsWith('audio/') ||
    file.name.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)
  );

  if (audioFiles.length === 0) {
    alert('Please select audio files (MP3, WAV, OGG, FLAC, M4A, AAC)');
    return;
  }

  pendingUploads = [...pendingUploads, ...audioFiles];
  renderPendingUploads();
};

// Process and save uploads
const processUploads = async () => {
  if (pendingUploads.length === 0) return;

  const progressEl = document.getElementById('upload-progress');
  const progressFill = document.getElementById('upload-progress-fill');
  const statusEl = document.getElementById('upload-status');
  const confirmBtn = document.getElementById('upload-confirm-btn');

  progressEl.style.display = 'block';
  confirmBtn.disabled = true;

  let completed = 0;
  const total = pendingUploads.length;

  for (const file of pendingUploads) {
    try {
      statusEl.textContent = `Uploading: ${file.name}`;

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();

      // Create song data object
      const songData = {
        id: `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: file.name.replace(/\.[^/.]+$/, ''), // Remove extension
        fileName: file.name,
        type: file.type,
        size: file.size,
        data: arrayBuffer,
        uploadedAt: new Date().toISOString()
      };

      // Save to IndexedDB
      await saveSongToDB(songData);

      completed++;
      const progress = (completed / total) * 100;
      progressFill.style.width = `${progress}%`;

    } catch (error) {
      console.error(`Failed to upload ${file.name}:`, error);
    }
  }

  statusEl.textContent = `Successfully uploaded ${completed} songs!`;

  // Clear pending and reload
  pendingUploads = [];
  renderPendingUploads();
  await loadUploadedSongs();

  // Close modal after delay
  setTimeout(() => {
    const modal = document.getElementById('upload-modal');
    if (modal) modal.style.display = 'none';
    progressEl.style.display = 'none';
    progressFill.style.width = '0%';
  }, 1500);
};

// Play uploaded song
const playUploadedSong = async (songId) => {
  const song = uploadedSongs.find(s => s.id === songId);
  if (!song) {
    console.error('Song not found:', songId);
    return;
  }

  // Create blob URL from stored data
  const blob = new Blob([song.data], { type: song.type || 'audio/mpeg' });
  const url = URL.createObjectURL(blob);

  // Play the song
  const audioPlayer = document.getElementById('audio-player');
  const audioElement = document.getElementById('song-audio');
  const titleElement = document.getElementById('song-title');
  const artistElement = document.getElementById('song-artist');

  // Revoke previous blob URL if exists
  if (audioElement.src && audioElement.src.startsWith('blob:')) {
    URL.revokeObjectURL(audioElement.src);
  }

  audioElement.src = url;
  titleElement.textContent = song.name;
  if (artistElement) artistElement.textContent = 'Uploaded';
  currentSong = { file: song.id, title: song.name, isUploaded: true };

  audioPlayer.style.display = 'flex';
  document.body.classList.add('player-active');
  addToHistory(song.id, song.name);
  updateRightPanels(song.id, song.name);

  audioElement.play().catch(e => console.error('Play error:', e));
};
window.playUploadedSong = playUploadedSong;

// Delete uploaded song
const deleteUploadedSong = async (songId) => {
  if (!confirm('Delete this song?')) return;

  try {
    await deleteSongFromDB(songId);
    await loadUploadedSongs();
  } catch (error) {
    console.error('Failed to delete song:', error);
  }
};
window.deleteUploadedSong = deleteUploadedSong;

// Render uploaded songs in Made For You card
const renderUploadedSongs = () => {
  const uploadedCard = document.getElementById('uploaded-card');
  const uploadedCardCount = document.getElementById('uploaded-card-count');

  if (uploadedSongs.length > 0) {
    // Show card in Made For You section
    if (uploadedCard) {
      uploadedCard.style.display = 'block';
      if (uploadedCardCount) {
        uploadedCardCount.textContent = `${uploadedSongs.length} song${uploadedSongs.length > 1 ? 's' : ''}`;
      }
    }
  } else {
    // Hide if no uploaded songs
    if (uploadedCard) uploadedCard.style.display = 'none';
  }

  // Remove old standalone section if exists
  const oldSection = document.getElementById('uploaded-songs-section');
  if (oldSection) oldSection.remove();
};

// Setup upload modal and handlers
const setupUploadModal = () => {
  const uploadBtn = document.getElementById('upload-btn');
  const uploadModal = document.getElementById('upload-modal');
  const uploadArea = document.getElementById('upload-area');
  const fileInput = document.getElementById('file-input');
  const closeBtn = document.getElementById('upload-modal-close');
  const cancelBtn = document.getElementById('upload-cancel-btn');
  const confirmBtn = document.getElementById('upload-confirm-btn');

  if (!uploadBtn || !uploadModal) return;

  // Open modal
  uploadBtn.addEventListener('click', () => {
    pendingUploads = [];
    renderPendingUploads();
    uploadModal.style.display = 'flex';
  });

  // Close modal
  const closeModal = () => {
    uploadModal.style.display = 'none';
    pendingUploads = [];
    renderPendingUploads();
  };

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  uploadModal.addEventListener('click', (e) => {
    if (e.target === uploadModal) closeModal();
  });

  // Click to select files
  if (uploadArea && fileInput) {
    uploadArea.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      handleFileSelect(e.target.files);
      fileInput.value = ''; // Reset
    });

    // Drag and drop
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      handleFileSelect(e.dataTransfer.files);
    });
  }

  // Confirm upload
  if (confirmBtn) {
    confirmBtn.addEventListener('click', processUploads);
  }

  // Uploaded card in Made For You section
  const uploadedCard = document.getElementById('uploaded-card');
  if (uploadedCard) {
    uploadedCard.addEventListener('click', () => {
      // Play first uploaded song
      if (uploadedSongs.length > 0) {
        playUploadedSong(uploadedSongs[0].id);
      }
    });
  }

  console.log('📤 Upload modal initialized');
};

// =====================================================
// INITIALIZE
// =====================================================

const init = async () => {
  console.log('🎵 Musicfy starting...');

  // Setup auth listener first
  setupAuthListener();

  // Check authentication
  const isAuthenticated = await checkAuth();

  if (!isAuthenticated) {
    console.log('❌ Not authenticated, redirecting to login...');
    return; // Will redirect to login
  }

  // Initialize upload database
  try {
    await initUploadDB();
    await loadUploadedSongs();
  } catch (error) {
    console.error('Failed to initialize upload DB:', error);
  }

  // Continue with initialization
  await loadSongs();
  await loadPlaylists();
  await loadHistory();
  loadStatus();

  setupEventListeners();
  setupPlayerControls();
  setupLeftNavigation();
  setupRightNavigation();
  setupModals();
  setupChat();
  setupAutoPlaylists();
  setupAiDj();
  setupMoodButtons();
  setupResizableSidebars();
  setupLogoutButton();
  setupUploadModal();

  // Show default sections
  showSection('default');

  console.log('🎵 Musicfy initialized!');
};

// Setup logout button
const setupLogoutButton = () => {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
};

// Start the app
init();
