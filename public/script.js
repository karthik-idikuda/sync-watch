// ===== GLOBALS =====
const socket = io('/', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
});
const videoGrid = document.getElementById('video-grid');
const myVideo = document.getElementById('local-video');
const mainVideo = document.getElementById('main-video');
const playBtn = document.getElementById('play-pause-btn');
const progressContainer = document.getElementById('progress-container');
const volumeSlider = document.getElementById('volume-slider');

// State
let myStream = null;
const peers = {};
const myId = Math.random().toString(36).substr(2, 9);
let roomId = null;
let isSyncing = false;
let hasVideo = false;
let currentPlatform = null; // 'youtube', 'vimeo', 'twitch', 'dailymotion', 'direct'
let username = 'Guest';
let isHost = false;
let playbackSpeed = 1;
let videoQueue = [];
let typingTimeout = null;
let currentAvatar = '👤';

// Players
let ytPlayer = null;
let vimeoPlayer = null;

// WebRTC Config
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// ===== PLATFORM DETECTION =====
const platformPatterns = {
    youtube: [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([^#&?\s]+)/,
        /^([a-zA-Z0-9_-]{11})$/ // Just video ID
    ],
    vimeo: [
        /(?:vimeo\.com\/)(\d+)/,
        /(?:player\.vimeo\.com\/video\/)(\d+)/
    ],
    twitch: [
        /(?:twitch\.tv\/videos\/)(\d+)/,
        /(?:twitch\.tv\/)([a-zA-Z0-9_]+)$/, // Live channel
        /(?:clips\.twitch\.tv\/)([a-zA-Z0-9_-]+)/
    ],
    dailymotion: [
        /(?:dailymotion\.com\/video\/)([a-zA-Z0-9]+)/,
        /(?:dai\.ly\/)([a-zA-Z0-9]+)/
    ],
    googledrive: [
        /(?:drive\.google\.com\/file\/d\/)([a-zA-Z0-9_-]+)/,
        /(?:drive\.google\.com\/open\?id=)([a-zA-Z0-9_-]+)/
    ],
    dropbox: [
        /(?:dropbox\.com\/s\/)([a-zA-Z0-9_-]+\/[^?]+)/,
        /(?:dropbox\.com\/scl\/)([a-zA-Z0-9_-]+\/[^?]+)/
    ],
    direct: [
        /\.(mp4|webm|ogg|m3u8|mkv|avi|mov)(\?.*)?$/i,
        /[?&]t=hls/i,
        /\/v\/[a-zA-Z0-9]+\?/i
    ],
    hls: [
        /\.m3u8(\?.*)?$/i,
        /[?&]t=hls/i,
        /[?&]type=hls/i
    ]
};

function detectPlatform(url) {
    // First check if it's an HLS stream (prioritize this)
    if (isHlsStream(url)) {
        return { platform: 'direct', id: null, url };
    }
    
    for (const [platform, patterns] of Object.entries(platformPatterns)) {
        // Skip HLS patterns as we already checked
        if (platform === 'hls') continue;
        
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return { platform, id: match[1], url };
            }
        }
    }
    // Default to direct if it looks like a video URL
    if (url.includes('http')) {
        return { platform: 'direct', id: null, url };
    }
    return null;
}

// Helper function defined before detectPlatform uses it
function isHlsStream(url) {
    return url.includes('.m3u8') || 
           url.includes('t=hls') || 
           url.includes('type=hls') ||
           url.includes('/hls/') ||
           url.includes('hls.') ||
           /\/v\/[a-zA-Z0-9]+\?.*sid=/.test(url);
}

// ===== YOUTUBE API =====
function onYouTubeIframeAPIReady() {
    console.log("YouTube API Ready");
}

function loadYouTubeVideo(videoId) {
    currentPlatform = 'youtube';
    hasVideo = true;
    hideAllPlayers();
    
    document.getElementById('youtube-player-container').style.display = 'block';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('big-play-btn').style.display = 'none';
    
    if (ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.loadVideoById(videoId);
    } else {
        ytPlayer = new YT.Player('youtube-player', {
            videoId: videoId,
            playerVars: {
                playsinline: 1,
                controls: 0,
                modestbranding: 1,
                rel: 0,
                fs: 0
            },
            events: {
                onReady: (e) => {
                    console.log("YT Player Ready");
                    if (playbackSpeed !== 1) {
                        e.target.setPlaybackRate(playbackSpeed);
                    }
                },
                onStateChange: onYTStateChange
            }
        });
    }
    
    updateVideoInfo("YouTube Video", "youtube");
}

function onYTStateChange(event) {
    if (isSyncing) return;
    
    if (event.data === YT.PlayerState.PLAYING) {
        playBtn.innerHTML = '<i class="fas fa-pause"></i>';
        document.getElementById('big-play-btn').style.display = 'none';
        socket.emit('sync-action', {
            roomId,
            type: 'play',
            currentTime: ytPlayer.getCurrentTime(),
            platform: 'youtube',
            speed: playbackSpeed
        });
    } else if (event.data === YT.PlayerState.PAUSED) {
        playBtn.innerHTML = '<i class="fas fa-play"></i>';
        document.getElementById('big-play-btn').style.display = 'flex';
        socket.emit('sync-action', {
            roomId,
            type: 'pause',
            currentTime: ytPlayer.getCurrentTime(),
            platform: 'youtube'
        });
    } else if (event.data === YT.PlayerState.ENDED) {
        playNextInQueue();
    }
}

// ===== VIMEO API =====
function loadVimeoVideo(videoId) {
    currentPlatform = 'vimeo';
    hasVideo = true;
    hideAllPlayers();
    
    document.getElementById('vimeo-player-container').style.display = 'block';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('big-play-btn').style.display = 'none';
    
    const container = document.getElementById('vimeo-player');
    container.innerHTML = '';
    
    vimeoPlayer = new Vimeo.Player(container, {
        id: videoId,
        controls: false,
        responsive: true
    });
    
    vimeoPlayer.on('play', function() {
        if (!isSyncing) {
            playBtn.innerHTML = '<i class="fas fa-pause"></i>';
            vimeoPlayer.getCurrentTime().then(time => {
                socket.emit('sync-action', {
                    roomId,
                    type: 'play',
                    currentTime: time,
                    platform: 'vimeo',
                    speed: playbackSpeed
                });
            });
        }
    });
    
    vimeoPlayer.on('pause', function() {
        if (!isSyncing) {
            playBtn.innerHTML = '<i class="fas fa-play"></i>';
            vimeoPlayer.getCurrentTime().then(time => {
                socket.emit('sync-action', {
                    roomId,
                    type: 'pause',
                    currentTime: time,
                    platform: 'vimeo'
                });
            });
        }
    });
    
    vimeoPlayer.on('ended', () => playNextInQueue());
    
    vimeoPlayer.getVideoTitle().then(title => {
        updateVideoInfo(title || "Vimeo Video", "vimeo");
    });
}

// ===== TWITCH EMBED =====
function loadTwitchVideo(videoId, isLive = false) {
    currentPlatform = 'twitch';
    hasVideo = true;
    hideAllPlayers();
    
    const iframe = document.getElementById('twitch-player');
    iframe.style.display = 'block';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('big-play-btn').style.display = 'none';
    
    if (isLive) {
        iframe.src = `https://player.twitch.tv/?channel=${videoId}&parent=${window.location.hostname}&autoplay=true`;
        updateVideoInfo(`Twitch: ${videoId} (Live)`, "twitch");
    } else {
        iframe.src = `https://player.twitch.tv/?video=${videoId}&parent=${window.location.hostname}&autoplay=true`;
        updateVideoInfo("Twitch Video", "twitch");
    }
}

// ===== DAILYMOTION EMBED =====
function loadDailymotionVideo(videoId) {
    currentPlatform = 'dailymotion';
    hasVideo = true;
    hideAllPlayers();
    
    const iframe = document.getElementById('dailymotion-player');
    iframe.style.display = 'block';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('big-play-btn').style.display = 'none';
    
    iframe.src = `https://www.dailymotion.com/embed/video/${videoId}?autoplay=1&controls=0`;
    updateVideoInfo("Dailymotion Video", "dailymotion");
}

// ===== GOOGLE DRIVE =====
function loadGoogleDriveVideo(fileId) {
    currentPlatform = 'direct';
    hasVideo = true;
    hideAllPlayers();
    
    mainVideo.style.display = 'block';
    document.getElementById('empty-state').style.display = 'none';
    
    // Convert Google Drive share link to direct link
    const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    mainVideo.src = directUrl;
    updateVideoInfo("Google Drive Video", "direct");
}

// ===== DROPBOX =====
function loadDropboxVideo(path) {
    currentPlatform = 'direct';
    hasVideo = true;
    hideAllPlayers();
    
    mainVideo.style.display = 'block';
    document.getElementById('empty-state').style.display = 'none';
    
    // Convert Dropbox share link to direct link
    const directUrl = `https://dl.dropboxusercontent.com/s/${path}`;
    mainVideo.src = directUrl;
    updateVideoInfo("Dropbox Video", "direct");
}

// ===== DIRECT VIDEO =====
let currentHls = null; // Store HLS instance for cleanup

function loadDirectVideo(url) {
    currentPlatform = 'direct';
    hasVideo = true;
    hideAllPlayers();
    
    // Cleanup previous HLS instance
    if (currentHls) {
        currentHls.destroy();
        currentHls = null;
    }
    
    mainVideo.style.display = 'block';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('big-play-btn').style.display = 'flex';
    
    // Handle HLS streams
    if (isHlsStream(url)) {
        console.log('Loading HLS stream:', url);
        
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            currentHls = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: 90,
                maxBufferLength: 30,
                maxMaxBufferLength: 600,
                maxBufferSize: 60 * 1000 * 1000,
                maxBufferHole: 0.5,
                xhrSetup: function(xhr, url) {
                    xhr.withCredentials = false;
                }
            });
            
            currentHls.loadSource(url);
            currentHls.attachMedia(mainVideo);
            
            currentHls.on(Hls.Events.MANIFEST_PARSED, function() {
                console.log('HLS manifest parsed, ready to play');
                document.getElementById('big-play-btn').style.display = 'flex';
            });
            
            currentHls.on(Hls.Events.ERROR, function(event, data) {
                console.error('HLS Error:', data);
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            showToast('Network error loading stream. Retrying...', 'error');
                            currentHls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            showToast('Media error. Attempting recovery...', 'warning');
                            currentHls.recoverMediaError();
                            break;
                        default:
                            showToast('Failed to load stream. Try a different source.', 'error');
                            currentHls.destroy();
                            break;
                    }
                }
            });
        } else if (mainVideo.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS support (Safari)
            console.log('Using native HLS support');
            mainVideo.src = url;
        } else {
            showToast('HLS streaming not supported in this browser', 'error');
            return;
        }
        updateVideoInfo("HLS Stream", "direct");
    } else {
        // Standard video file
        mainVideo.src = url;
        updateVideoInfo("Now Playing", "direct");
    }
    
    mainVideo.playbackRate = playbackSpeed;
}

function hideAllPlayers() {
    mainVideo.style.display = 'none';
    document.getElementById('youtube-player-container').style.display = 'none';
    document.getElementById('vimeo-player-container').style.display = 'none';
    document.getElementById('twitch-player').style.display = 'none';
    document.getElementById('dailymotion-player').style.display = 'none';
}

function updateVideoInfo(title, platform) {
    document.getElementById('video-title').innerText = title;
    const platformBadge = document.getElementById('video-platform');
    
    const icons = {
        youtube: '<i class="fab fa-youtube"></i> YouTube',
        vimeo: '<i class="fab fa-vimeo-v"></i> Vimeo',
        twitch: '<i class="fab fa-twitch"></i> Twitch',
        dailymotion: '<i class="fab fa-dailymotion"></i> Dailymotion',
        direct: '<i class="fas fa-file-video"></i> Video'
    };
    
    platformBadge.innerHTML = icons[platform] || '';
    platformBadge.className = `video-platform ${platform}`;
}

// ===== INITIALIZATION =====
const urlParams = new URLSearchParams(window.location.search);
const roomParam = urlParams.get('room');

// Check for saved username
const savedUsername = localStorage.getItem('syncwatch-username');
if (savedUsername) {
    const input = document.getElementById('username-input');
    if (input) input.value = savedUsername;
    username = savedUsername;
}

// Check for saved avatar
const savedAvatar = localStorage.getItem('syncwatch-avatar');
if (savedAvatar) {
    currentAvatar = savedAvatar;
    const avatarBtn = document.getElementById('avatar-btn');
    if (avatarBtn) avatarBtn.innerText = currentAvatar;
}

if (roomParam) {
    checkRoomForJoin(roomParam);
}

// Modal Functions
function showCreateRoomModal() {
    username = document.getElementById('username-input').value.trim() || 'Guest';
    localStorage.setItem('syncwatch-username', username);
    document.getElementById('create-room-modal').classList.add('show');
}

function closeCreateRoomModal() {
    document.getElementById('create-room-modal').classList.remove('show');
}

function createRoom() {
    const password = document.getElementById('create-room-password').value.trim();
    isHost = true;
    
    // If using modal, close it
    closeCreateRoomModal();
    
    // Register room creation with server (to save password)
    socket.emit('create-room', password);
}

socket.on('room-created', (newRoomId) => {
    joinRoom(newRoomId, document.getElementById('create-room-password').value.trim());
});

let pendingRoomId = null;

function checkRoomForJoin(idOverride) {
    const code = idOverride || document.getElementById('room-code-input').value.trim();
    if (!code) {
        showToast("Please enter a room code", "error");
        return;
    }
    
    username = document.getElementById('username-input').value.trim() || 'Guest';
    localStorage.setItem('syncwatch-username', username);
    
    pendingRoomId = code;
    
    socket.emit('check-room', code, (response) => {
        if (!response.exists) {
             // For direct URL access, just try to join (might be a new room)
             // But for manual entry, show error
             if (idOverride) {
                 // It's a URL join, treat as new room or handle error?
                 // Current logic: treating as new/direct join
                 joinRoom(code);
             } else {
                 showToast("Room not found", "error");
             }
             return;
        }
        
        if (response.hasPassword) {
            document.getElementById('join-password-modal').classList.add('show');
            document.getElementById('landing-page').style.display = 'none'; // Optional: hide landing if coming from URL
        } else {
            joinRoom(code);
        }
    });
}

function closeJoinPasswordModal() {
    document.getElementById('join-password-modal').classList.remove('show');
    pendingRoomId = null;
    if (roomParam) {
        // If they cancelled on a URL join, redirect home
        window.location.href = '/';
    }
}

function joinRoomWithPassword() {
    const password = document.getElementById('join-room-password').value.trim();
    if (!password) return;
    
    closeJoinPasswordModal();
    joinRoom(pendingRoomId, password);
}

function joinRoom(id, password = null) {
    roomId = id;
    username = document.getElementById('username-input')?.value.trim() || username || 'Guest';
    
    document.getElementById('landing-page').style.display = 'none';
    document.getElementById('app-container').classList.remove('hidden');
    document.getElementById('display-room-code').innerText = roomId.substring(0, 8) + '...';
    document.getElementById('local-username').innerText = username;
    
    if (!roomParam || roomParam !== roomId) {
        window.history.pushState({}, '', `/?room=${roomId}`);
    }
    
    startMedia(password);
}

async function startMedia(password = null) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        myStream = stream;
        myVideo.srcObject = stream;
        myVideo.play();
    socket.emit('join-room', roomId, myId, username, password, currentAvatar);
    } catch (err) {
        console.warn("Media access denied:", err);
        showToast("Camera access denied. You can still watch!", "info");
        socket.emit('join-room', roomId, myId, username, password, currentAvatar);
    }
}

// Socket Error Handling (e.g. wrong password)
socket.on('error', (msg) => {
    showToast(msg, 'error');
    if (msg === 'Incorrect password') {
        // Show modal again
        document.getElementById('join-password-modal').classList.add('show');
    }
});

// Kick Handling
socket.on('banned', () => {
    alert("You have been kicked from the room.");
    window.location.href = '/';
});

// ===== CONNECTION STATUS =====
socket.on('connect', () => {
    updateConnectionStatus('connected');
});

socket.on('disconnect', () => {
    updateConnectionStatus('disconnected');
});

socket.on('reconnecting', () => {
    updateConnectionStatus('connecting');
});

function updateConnectionStatus(status) {
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    
    dot.className = 'status-dot ' + status;
    
    const statusTexts = {
        connected: 'Connected',
        disconnected: 'Disconnected',
        connecting: 'Reconnecting...'
    };
    text.innerText = statusTexts[status] || status;
}

// ===== SOCKET EVENTS =====
socket.on('user-connected', data => {
    const name = typeof data === 'object' ? data.username : 'User';
    showToast(`${name} joined!`, "success");
    updateUserCount();
    if (myStream) connectToNewUser(data.userId || data, myStream);
});

socket.on('user-disconnected', data => {
    const userId = typeof data === 'object' ? data.userId : data; // data.odId from server
    const actualId = typeof data === 'object' && data.odId ? data.odId : userId;
    
    showToast("User left", "info");
    if (peers[actualId]) {
        peers[actualId].close();
        delete peers[actualId];
    }
    const container = document.getElementById(`video-container-${actualId}`);
    if (container) container.remove();
    updateUserCount();
});

socket.on('user-count', count => {
    document.getElementById('user-count').innerText = `(${count})`;
});

socket.on('room-state', (state) => {
    console.log("Room state received:", state);
    if (!state || !state.url) return;
    
    document.getElementById('video-url-input').value = state.url;
    
    const platformInfo = detectPlatform(state.url);
    if (platformInfo) {
        loadVideoByPlatform(platformInfo);
        
        // Sync position after load
        setTimeout(() => {
            syncToPosition(state.currentTime || 0, state.isPlaying, state.speed || 1);
        }, 2000);
    }
    
    // Load queue if exists
    if (state.queue && state.queue.length > 0) {
        videoQueue = state.queue;
        updateQueueUI();
    }
    
    showToast("Synced with room!", "success");
});

function syncToPosition(time, isPlaying, speed) {
    playbackSpeed = speed || 1;
    updateSpeedUI();
    
    if (currentPlatform === 'youtube' && ytPlayer && ytPlayer.seekTo) {
        ytPlayer.seekTo(time, true);
        ytPlayer.setPlaybackRate(playbackSpeed);
        if (isPlaying) ytPlayer.playVideo();
    } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
        vimeoPlayer.setCurrentTime(time);
        vimeoPlayer.setPlaybackRate(playbackSpeed);
        if (isPlaying) vimeoPlayer.play();
    } else if (currentPlatform === 'direct') {
        mainVideo.currentTime = time;
        mainVideo.playbackRate = playbackSpeed;
        if (isPlaying) mainVideo.play().catch(() => {});
    }
}

// ===== WEBRTC =====
socket.on('offer', async data => {
    if (data.odId === myId) return;
    const pc = createPeerConnection(data.odId, data.username);
    peers[data.odId] = pc;
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { answer, roomId, odId: myId, username });
});

socket.on('answer', async data => {
    if (peers[data.odId]) {
        await peers[data.odId].setRemoteDescription(new RTCSessionDescription(data.answer));
    }
});

socket.on('ice-candidate', async data => {
    if (peers[data.odId]) {
        try {
            await peers[data.odId].addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) { console.error("ICE Error", e); }
    }
});

function createPeerConnection(userId, peerUsername) {
    const pc = new RTCPeerConnection(rtcConfig);
    
    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', { candidate: event.candidate, roomId, odId: myId });
        }
    };
    
    // Add our local tracks to the connection
    if (myStream) {
        myStream.getTracks().forEach(track => pc.addTrack(track, myStream));
    }

    pc.ontrack = event => {
        // Check if card exists
        let card = document.getElementById(`video-container-${userId}`);
        
        if (!card) {
            card = document.createElement('div');
            card.className = 'webcam-card';
            card.id = `video-container-${userId}`;
            
            const video = document.createElement('video');
            video.id = `video-${userId}`;
            video.autoplay = true;
            video.playsinline = true;
            
            const label = document.createElement('span');
            label.className = 'webcam-label';
            const avatarDisplay = peers[userId]?.avatar || '👤'; 
            label.innerText = `${avatarDisplay} ${peerUsername || 'Guest'}`;
            
            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn';
            kickBtn.innerHTML = '<i class="fas fa-ban"></i>';
            kickBtn.title = 'Kick User';
            kickBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm(`Kick ${peerUsername || 'user'}?`)) {
                    socket.emit('kick-user', userId);
                }
            };
            if (!isHost) kickBtn.style.display = 'none';
    
            card.appendChild(video);
            card.appendChild(label);
            card.appendChild(kickBtn);
            videoGrid.appendChild(card);
        }
        
        // Attach stream to video element
        const videoEl = card.querySelector('video');
        if (videoEl && event.streams[0]) {
            videoEl.srcObject = event.streams[0];
        }
        
        updateUserCount();
    };

    return pc;
}

function connectToNewUser(userId, stream) {
    const pc = createPeerConnection(userId);
    peers[userId] = pc;
    pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socket.emit('offer', { offer, roomId, odId: myId, username });
    });
}

function updateUserCount() {
    const count = document.querySelectorAll('.webcam-card').length;
    document.getElementById('user-count').innerText = `(${count})`;
}

// ===== SYNC ACTION HANDLER =====
socket.on('sync-action', data => {
    // Handle queue updates
    if (data.type === 'queue-update') {
        videoQueue = data.queue || [];
        updateQueueUI();
        return;
    }
    
    // Handle URL changes
    if (data.type === 'url') {
        document.getElementById('video-url-input').value = data.url;
        const platformInfo = detectPlatform(data.url);
        if (platformInfo) {
            loadVideoByPlatform(platformInfo);
        }
        showToast("Video changed", "info");
        return;
    }
    
    // Handle speed changes
    if (data.type === 'speed') {
        playbackSpeed = data.speed;
        updateSpeedUI();
        setPlaybackSpeed(data.speed, false);
        return;
    }
    
    // Prevent sync loops
    if (isSyncing) return;
    isSyncing = true;
    
    // Handle sync based on platform
    if (data.platform === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) {
        if (Math.abs(ytPlayer.getCurrentTime() - data.currentTime) > 1) {
            ytPlayer.seekTo(data.currentTime, true);
        }
        if (data.type === 'play') ytPlayer.playVideo();
        else if (data.type === 'pause') ytPlayer.pauseVideo();
    } else if (data.platform === 'vimeo' && vimeoPlayer) {
        vimeoPlayer.getCurrentTime().then(current => {
            if (Math.abs(current - data.currentTime) > 1) {
                vimeoPlayer.setCurrentTime(data.currentTime);
            }
        });
        if (data.type === 'play') vimeoPlayer.play();
        else if (data.type === 'pause') vimeoPlayer.pause();
    } else if (data.platform === 'direct') {
        if (Math.abs(mainVideo.currentTime - data.currentTime) > 0.5) {
            mainVideo.currentTime = data.currentTime;
        }
        if (data.type === 'play') mainVideo.play().catch(() => {});
        else if (data.type === 'pause') mainVideo.pause();
    }
    
    // Update play button UI
    if (data.type === 'play') {
        playBtn.innerHTML = '<i class="fas fa-pause"></i>';
        document.getElementById('big-play-btn').style.display = 'none';
    } else if (data.type === 'pause') {
        playBtn.innerHTML = '<i class="fas fa-play"></i>';
        document.getElementById('big-play-btn').style.display = 'flex';
    }
    
    setTimeout(() => { isSyncing = false; }, 300);
});

// ===== VIDEO SYNC EVENTS =====
mainVideo.addEventListener('play', () => {
    playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    document.getElementById('big-play-btn').style.display = 'none';
    if (!isSyncing && currentPlatform === 'direct') {
        socket.emit('sync-action', { 
            roomId, type: 'play', currentTime: mainVideo.currentTime, 
            platform: 'direct', speed: playbackSpeed 
        });
    }
});

mainVideo.addEventListener('pause', () => {
    playBtn.innerHTML = '<i class="fas fa-play"></i>';
    document.getElementById('big-play-btn').style.display = 'flex';
    if (!isSyncing && currentPlatform === 'direct') {
        socket.emit('sync-action', { 
            roomId, type: 'pause', currentTime: mainVideo.currentTime, 
            platform: 'direct' 
        });
    }
});

mainVideo.addEventListener('seeked', () => {
    if (!isSyncing && currentPlatform === 'direct') {
        socket.emit('sync-action', { 
            roomId, type: 'seeked', currentTime: mainVideo.currentTime, 
            platform: 'direct' 
        });
    }
});

mainVideo.addEventListener('ratechange', () => {
    if (!isSyncing && currentPlatform === 'direct') {
        socket.emit('sync-action', { 
            roomId, type: 'speed', speed: mainVideo.playbackRate, 
            platform: 'direct' 
        });
    }
});

mainVideo.addEventListener('timeupdate', updateProgress);
mainVideo.addEventListener('loadedmetadata', () => {
    document.getElementById('duration').innerText = formatTime(mainVideo.duration);
    document.getElementById('big-play-btn').style.display = 'flex';
});

mainVideo.addEventListener('ended', () => playNextInQueue());

mainVideo.addEventListener('error', () => {
    showToast("Video failed to load. Check the URL.", "error");
});

mainVideo.addEventListener('progress', () => {
    if (mainVideo.buffered.length > 0) {
        const bufferedEnd = mainVideo.buffered.end(mainVideo.buffered.length - 1);
        const duration = mainVideo.duration;
        const bufferedPercent = (bufferedEnd / duration) * 100;
        document.getElementById('progress-buffered').style.width = bufferedPercent + '%';
    }
});

// ===== VIDEO LOADING =====
function loadVideo() {
    const url = document.getElementById('video-url-input').value.trim();
    if (!url) {
        showToast("Please enter a URL", "error");
        return;
    }
    
    const platformInfo = detectPlatform(url);
    if (!platformInfo) {
        showToast("Unsupported video URL", "error");
        return;
    }
    
    loadVideoByPlatform(platformInfo);
    
    // Notify room
    socket.emit('sync-action', { 
        roomId, type: 'url', url, 
        platform: platformInfo.platform, 
        videoId: platformInfo.id,
        currentTime: 0 
    });
}

function loadVideoByPlatform(info) {
    const { platform, id, url } = info;
    
    switch (platform) {
        case 'youtube':
            loadYouTubeVideo(id);
            break;
        case 'vimeo':
            loadVimeoVideo(id);
            break;
        case 'twitch':
            const isLive = !url.includes('/videos/');
            loadTwitchVideo(id, isLive);
            break;
        case 'dailymotion':
            loadDailymotionVideo(id);
            break;
        case 'googledrive':
            loadGoogleDriveVideo(id);
            break;
        case 'dropbox':
            loadDropboxVideo(id);
            break;
        default:
            loadDirectVideo(url);
    }
}

function loadTestVideo() {
    document.getElementById('video-url-input').value = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
    loadVideo();
}

// ===== VIDEO QUEUE =====
function addToQueue() {
    const url = document.getElementById('video-url-input').value.trim();
    if (!url) {
        showToast("Please enter a URL", "error");
        return;
    }
    
    const platformInfo = detectPlatform(url);
    if (!platformInfo) {
        showToast("Unsupported video URL", "error");
        return;
    }
    
    videoQueue.push({ url, platform: platformInfo.platform, title: `Video ${videoQueue.length + 1}` });
    updateQueueUI();
    
    socket.emit('sync-action', { roomId, type: 'queue-update', queue: videoQueue });
    showToast("Added to queue", "success");
    
    document.getElementById('video-url-input').value = '';
    
    // If no video playing, load first in queue
    if (!hasVideo && videoQueue.length === 1) {
        playNextInQueue();
    }
}

function playNextInQueue() {
    if (videoQueue.length === 0) {
        showToast("Queue is empty", "info");
        return;
    }
    
    const next = videoQueue.shift();
    updateQueueUI();
    
    document.getElementById('video-url-input').value = next.url;
    loadVideo();
    
    socket.emit('sync-action', { roomId, type: 'queue-update', queue: videoQueue });
}

function removeFromQueue(index) {
    videoQueue.splice(index, 1);
    updateQueueUI();
    socket.emit('sync-action', { roomId, type: 'queue-update', queue: videoQueue });
}

function clearQueue() {
    videoQueue = [];
    updateQueueUI();
    socket.emit('sync-action', { roomId, type: 'queue-update', queue: videoQueue });
    showToast("Queue cleared", "info");
}

function updateQueueUI() {
    const list = document.getElementById('queue-list');
    const count = document.getElementById('queue-count');
    const clearBtn = document.getElementById('clear-queue-btn');
    
    count.innerText = `(${videoQueue.length})`;
    
    if (videoQueue.length === 0) {
        list.innerHTML = '<p class="queue-empty">No videos in queue</p>';
        clearBtn.style.display = 'none';
        return;
    }
    
    clearBtn.style.display = 'block';
    list.innerHTML = videoQueue.map((item, i) => `
        <div class="queue-item">
            <span class="queue-num">${i + 1}.</span>
            <span class="queue-title">${item.title || item.url.substring(0, 30)}...</span>
            <button class="queue-remove" onclick="removeFromQueue(${i})">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');
}

// ===== PLAYER CONTROLS =====
playBtn.addEventListener('click', togglePlayPause);

document.getElementById('big-play-btn').addEventListener('click', togglePlayPause);

function togglePlayPause() {
    if (currentPlatform === 'youtube' && ytPlayer) {
        const state = ytPlayer.getPlayerState();
        if (state === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
        else ytPlayer.playVideo();
    } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
        vimeoPlayer.getPaused().then(paused => {
            if (paused) vimeoPlayer.play();
            else vimeoPlayer.pause();
        });
    } else if (currentPlatform === 'direct') {
        if (mainVideo.paused) mainVideo.play();
        else mainVideo.pause();
    }
}

// Progress bar
progressContainer.addEventListener('click', seekToPosition);
progressContainer.addEventListener('mousemove', showProgressTooltip);

function seekToPosition(e) {
    const rect = progressContainer.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    
    if (currentPlatform === 'youtube' && ytPlayer) {
        const time = percent * ytPlayer.getDuration();
        ytPlayer.seekTo(time, true);
        if (!isSyncing) {
            socket.emit('sync-action', { roomId, type: 'seeked', currentTime: time, platform: 'youtube' });
        }
    } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
        vimeoPlayer.getDuration().then(duration => {
            const time = percent * duration;
            vimeoPlayer.setCurrentTime(time);
            if (!isSyncing) {
                socket.emit('sync-action', { roomId, type: 'seeked', currentTime: time, platform: 'vimeo' });
            }
        });
    } else if (currentPlatform === 'direct') {
        mainVideo.currentTime = percent * mainVideo.duration;
    }
}

function showProgressTooltip(e) {
    const rect = progressContainer.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const tooltip = document.getElementById('progress-tooltip');
    
    let duration = 0;
    if (currentPlatform === 'youtube' && ytPlayer && ytPlayer.getDuration) {
        duration = ytPlayer.getDuration();
    } else if (currentPlatform === 'direct') {
        duration = mainVideo.duration;
    }
    
    const time = percent * duration;
    tooltip.innerText = formatTime(time);
    tooltip.style.left = (percent * 100) + '%';
}

// Skip buttons
document.getElementById('skip-back-btn').addEventListener('click', () => skip(-10));
document.getElementById('skip-forward-btn').addEventListener('click', () => skip(10));

function skip(seconds) {
    if (currentPlatform === 'youtube' && ytPlayer) {
        const newTime = ytPlayer.getCurrentTime() + seconds;
        ytPlayer.seekTo(Math.max(0, newTime), true);
        socket.emit('sync-action', { roomId, type: 'seeked', currentTime: newTime, platform: 'youtube' });
    } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
        vimeoPlayer.getCurrentTime().then(current => {
            const newTime = Math.max(0, current + seconds);
            vimeoPlayer.setCurrentTime(newTime);
            socket.emit('sync-action', { roomId, type: 'seeked', currentTime: newTime, platform: 'vimeo' });
        });
    } else if (currentPlatform === 'direct') {
        mainVideo.currentTime = Math.max(0, mainVideo.currentTime + seconds);
    }
}

// Volume
volumeSlider.addEventListener('input', (e) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
});

document.getElementById('volume-btn').addEventListener('click', toggleMute);

function setVolume(vol) {
    if (currentPlatform === 'youtube' && ytPlayer) {
        ytPlayer.setVolume(vol * 100);
        if (vol === 0) ytPlayer.mute();
        else ytPlayer.unMute();
    } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
        vimeoPlayer.setVolume(vol);
    } else {
        mainVideo.volume = vol;
    }
    updateVolumeIcon(vol);
}

function toggleMute() {
    const current = parseFloat(volumeSlider.value);
    if (current > 0) {
        volumeSlider.dataset.prevVolume = current;
        volumeSlider.value = 0;
        setVolume(0);
    } else {
        const prev = parseFloat(volumeSlider.dataset.prevVolume || 1);
        volumeSlider.value = prev;
        setVolume(prev);
    }
}

function updateVolumeIcon(vol) {
    const icon = document.querySelector('#volume-btn i');
    if (vol === 0) icon.className = 'fas fa-volume-mute';
    else if (vol < 0.5) icon.className = 'fas fa-volume-down';
    else icon.className = 'fas fa-volume-up';
}

// Speed control
document.getElementById('speed-btn').addEventListener('click', () => {
    document.getElementById('speed-menu').classList.toggle('show');
});

document.querySelectorAll('#speed-menu button').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const speed = parseFloat(e.target.dataset.speed);
        setPlaybackSpeed(speed, true);
        document.getElementById('speed-menu').classList.remove('show');
    });
});

function setPlaybackSpeed(speed, broadcast = true) {
    playbackSpeed = speed;
    
    if (currentPlatform === 'youtube' && ytPlayer) {
        ytPlayer.setPlaybackRate(speed);
    } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
        vimeoPlayer.setPlaybackRate(speed);
    } else if (currentPlatform === 'direct') {
        mainVideo.playbackRate = speed;
    }
    
    updateSpeedUI();
    
    if (broadcast) {
        socket.emit('sync-action', { roomId, type: 'speed', speed, platform: currentPlatform });
    }
}

function updateSpeedUI() {
    document.getElementById('speed-btn').innerText = playbackSpeed + 'x';
    document.querySelectorAll('#speed-menu button').forEach(btn => {
        btn.classList.toggle('active', parseFloat(btn.dataset.speed) === playbackSpeed);
    });
}

// Fullscreen
document.getElementById('fullscreen-btn').addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
    const wrapper = document.getElementById('player-wrapper');
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        wrapper.requestFullscreen().catch(() => {});
    }
}

// Picture-in-Picture
document.getElementById('pip-btn').addEventListener('click', togglePiP);

async function togglePiP() {
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else if (currentPlatform === 'direct' && mainVideo.requestPictureInPicture) {
            await mainVideo.requestPictureInPicture();
        } else {
            showToast("PiP only works with direct videos", "info");
        }
    } catch (err) {
        console.error("PiP error:", err);
        showToast("Picture-in-Picture not supported", "error");
    }
}

// Theater Mode & Sidebar Toggle
document.getElementById('theater-btn').addEventListener('click', toggleTheaterMode);
// Make sure this button actually exists in HTML or handle if it doesn't
const sidebarToggle = document.getElementById('toggle-sidebar-btn');
if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
        // Toggle sidebar specifically
        const app = document.getElementById('app-container');
        app.classList.toggle('theater-mode');
    });
}

function toggleTheaterMode() {
    const app = document.getElementById('app-container');
    app.classList.toggle('theater-mode');
    
    // Update icons
    const theaterIcon = document.querySelector('#theater-btn i');
    if (theaterIcon) {
        if (app.classList.contains('theater-mode')) {
            theaterIcon.className = 'fas fa-compress';
        } else {
            theaterIcon.className = 'fas fa-tv';
        }
    }
}

function updateProgress() {
    if (currentPlatform !== 'direct') return;
    const percent = (mainVideo.currentTime / mainVideo.duration) * 100;
    document.getElementById('progress-bar').style.width = percent + '%';
    document.getElementById('progress-thumb').style.left = percent + '%';
    document.getElementById('current-time').innerText = formatTime(mainVideo.currentTime);
}

// YouTube/Vimeo progress polling
setInterval(() => {
    if (currentPlatform === 'youtube' && ytPlayer && ytPlayer.getDuration) {
        const current = ytPlayer.getCurrentTime();
        const duration = ytPlayer.getDuration();
        const percent = (current / duration) * 100;
        document.getElementById('progress-bar').style.width = percent + '%';
        document.getElementById('progress-thumb').style.left = percent + '%';
        document.getElementById('current-time').innerText = formatTime(current);
        document.getElementById('duration').innerText = formatTime(duration);
    } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
        Promise.all([vimeoPlayer.getCurrentTime(), vimeoPlayer.getDuration()]).then(([current, duration]) => {
            const percent = (current / duration) * 100;
            document.getElementById('progress-bar').style.width = percent + '%';
            document.getElementById('progress-thumb').style.left = percent + '%';
            document.getElementById('current-time').innerText = formatTime(current);
            document.getElementById('duration').innerText = formatTime(duration);
        }).catch(() => {});
    }
}, 500);

function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
    // Skip if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    const key = e.key.toLowerCase();
    
    switch (key) {
        case ' ':
        case 'k':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'arrowleft':
        case 'j':
            e.preventDefault();
            skip(-10);
            break;
        case 'arrowright':
        case 'l':
            e.preventDefault();
            skip(10);
            break;
        case 'arrowup':
            e.preventDefault();
            setVolume(Math.min(1, parseFloat(volumeSlider.value) + 0.1));
            volumeSlider.value = Math.min(1, parseFloat(volumeSlider.value) + 0.1);
            break;
        case 'arrowdown':
            e.preventDefault();
            setVolume(Math.max(0, parseFloat(volumeSlider.value) - 0.1));
            volumeSlider.value = Math.max(0, parseFloat(volumeSlider.value) - 0.1);
            break;
        case 'm':
            toggleMute();
            break;
        case 'f':
            toggleFullscreen();
            break;
        case 't':
            toggleTheaterMode();
            break;
        case 'p':
            togglePiP();
            break;
        case '>':
        case '.':
            e.preventDefault();
            const speedsUp = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
            const currentIdxUp = speedsUp.indexOf(playbackSpeed);
            if (currentIdxUp < speedsUp.length - 1) {
                setPlaybackSpeed(speedsUp[currentIdxUp + 1], true);
            }
            break;
        case '<':
        case ',':
            e.preventDefault();
            const speedsDown = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
            const currentIdxDown = speedsDown.indexOf(playbackSpeed);
            if (currentIdxDown > 0) {
                setPlaybackSpeed(speedsDown[currentIdxDown - 1], true);
            }
            break;
        case '?':
            openShortcutsModal();
            break;
        case 'escape':
            closeShortcutsModal();
            closeShareModal();
            break;
        default:
            // Number keys for seeking
            if (/^[0-9]$/.test(key)) {
                const percent = parseInt(key) / 10;
                if (currentPlatform === 'youtube' && ytPlayer) {
                    ytPlayer.seekTo(percent * ytPlayer.getDuration(), true);
                } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
                    vimeoPlayer.getDuration().then(d => vimeoPlayer.setCurrentTime(percent * d));
                } else if (currentPlatform === 'direct') {
                    mainVideo.currentTime = percent * mainVideo.duration;
                }
            }
    }
});

// ===== CHAT =====
function sendMessage() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    
    appendMessage(username, msg, true, currentAvatar);
    socket.emit('chat-message', { roomId, msg, username, avatar: currentAvatar });
    input.value = '';
    
    // Stop typing indicator
    socket.emit('typing', { roomId, username, isTyping: false });
}

socket.on('chat-message', data => {
    appendMessage(data.username || 'Guest', data.msg, false, data.avatar);
});

function appendMessage(sender, text, isSelf, avatar = '👤') {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = `chat-message ${isSelf ? '' : 'other'}`;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Add avatar span if needed, or just prefix to name
    // Using a span for styling
    const avatarHtml = `<span class="chat-avatar">${avatar}</span>`;
    
    div.innerHTML = `${avatarHtml}<span class="sender">${sender}</span>${text}<span class="timestamp">${time}</span>`;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// Typing indicator
const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
        return;
    }
    
    // Send typing indicator
    socket.emit('typing', { roomId, username, isTyping: true });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing', { roomId, username, isTyping: false });
    }, 2000);
});

socket.on('typing', data => {
    const indicator = document.getElementById('typing-indicator');
    if (data.isTyping) {
        indicator.querySelector('.typing-name').innerText = data.username;
        indicator.classList.add('show');
    } else {
        indicator.classList.remove('show');
    }
});

// Toggle chat
document.getElementById('toggle-chat-btn')?.addEventListener('click', () => {
    const chat = document.getElementById('chat-container');
    chat.classList.toggle('minimized');
    const icon = document.querySelector('#toggle-chat-btn i');
    icon.classList.toggle('fa-chevron-down');
    icon.classList.toggle('fa-chevron-up');
});

// ===== REACTIONS =====
function sendReaction(emoji) {
    showFloatingReaction(emoji);
    socket.emit('reaction', { roomId, emoji });
}

socket.on('reaction', data => showFloatingReaction(data.emoji));

function showFloatingReaction(emoji) {
    const container = document.getElementById('reactions-container');
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.innerText = emoji;
    el.style.left = Math.random() * 100 + 'px';
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

// ===== MODALS =====
function openShareModal() {
    const modal = document.getElementById('share-modal');
    const url = window.location.origin + '/?room=' + roomId;
    document.getElementById('share-url-input').value = url;
    
    // Generate simple QR code
    const qrContainer = document.getElementById('qr-code');
    qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}" alt="QR Code">`;
    
    modal.classList.add('show');
}

function closeShareModal() {
    document.getElementById('share-modal').classList.remove('show');
}

function copyShareUrl() {
    const url = document.getElementById('share-url-input').value;
    navigator.clipboard.writeText(url);
    showToast("Link copied!", "success");
}

function shareVia(platform) {
    const url = window.location.origin + '/?room=' + roomId;
    const text = "Join my SyncWatch room!";
    
    const links = {
        whatsapp: `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`,
        telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
        twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
        email: `mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(url)}`
    };
    
    window.open(links[platform], '_blank');
}

function openShortcutsModal() {
    document.getElementById('shortcuts-modal').classList.add('show');
}

function closeShortcutsModal() {
    document.getElementById('shortcuts-modal').classList.remove('show');
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('show');
        }
    });
});

// ===== USER AVATAR FUNCTIONS =====
function toggleAvatarMenu() {
    const menu = document.getElementById('avatar-menu');
    menu.classList.toggle('hidden');
}

function selectAvatar(avatar) {
    currentAvatar = avatar;
    document.getElementById('avatar-btn').innerText = avatar;
    localStorage.setItem('syncwatch-avatar', avatar);
    toggleAvatarMenu();
}

// Close avatar menu when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.avatar-selector')) {
        const menu = document.getElementById('avatar-menu');
        if (menu && !menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
        }
    }
});

// ===== ROOM SETTINGS =====
function showRoomSettings() {
    document.getElementById('room-settings-modal').classList.add('show');
}

function closeRoomSettings() {
    document.getElementById('room-settings-modal').classList.remove('show');
}

function toggleRoomLock(checkbox) {
    const isLocked = checkbox.checked;
    socket.emit('lock-room', isLocked);
}

socket.on('room-locked', (locked) => {
    const toggle = document.getElementById('lock-room-toggle');
    if (toggle) toggle.checked = locked;
    
    if (isHost) {
        showToast(locked ? "Room Locked" : "Room Unlocked", "info");
    } else {
        // Maybe show icon somewhere for others?
        showToast(locked ? "Host locked the room" : "Host unlocked the room", "info");
    }
});

// ===== SUBTITLES =====
function loadSubtitles(input) {
    const file = input.files[0];
    if (!file) return;

    if (currentPlatform !== 'direct') {
        showToast("Subtitles only supported for direct videos for now", "warning");
        return;
    }

    const track = document.createElement("track");
    track.kind = "captions";
    track.label = "English";
    track.srclang = "en";
    track.src = URL.createObjectURL(file);
    track.default = true;
    
    // Remove old tracks
    const video = document.getElementById('main-video');
    video.querySelectorAll('track').forEach(t => t.remove());
    
    video.appendChild(track);
    video.textTracks[0].mode = "showing";
    
    showToast("Subtitles loaded", "success");
}

// ===== UI HELPERS =====
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? 'check-circle' : 
                 type === 'error' ? 'exclamation-circle' : 
                 type === 'warning' ? 'exclamation-triangle' : 'info-circle';
                 
    toast.innerHTML = `<i class="fas fa-${icon}"></i> ${msg}`;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function copyRoomCode() {
    navigator.clipboard.writeText(roomId);
    showToast("Room code copied!", "success");
}

// ===== MEDIA CONTROLS =====
document.getElementById('toggle-mic-btn').addEventListener('click', (e) => {
    if (!myStream) return;
    const track = myStream.getAudioTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        e.currentTarget.classList.toggle('active');
        const icon = e.currentTarget.querySelector('i');
        icon.classList.toggle('fa-microphone');
        icon.classList.toggle('fa-microphone-slash');
    }
});

document.getElementById('toggle-cam-btn').addEventListener('click', (e) => {
    if (!myStream) return;
    const track = myStream.getVideoTracks()[0];
    if (track) {
        track.enabled = !track.enabled;
        e.currentTarget.classList.toggle('active');
        const icon = e.currentTarget.querySelector('i');
        icon.classList.toggle('fa-video');
        icon.classList.toggle('fa-video-slash');
    }
});

document.getElementById('leave-btn').addEventListener('click', () => {
    if (myStream) {
        myStream.getTracks().forEach(track => track.stop());
    }
    window.location.href = '/';
});

// ===== PLAYER HOVER CONTROLS =====
let controlsTimeout;
const playerWrapper = document.getElementById('player-wrapper');

playerWrapper.addEventListener('mousemove', () => {
    playerWrapper.classList.add('show-controls');
    clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
        playerWrapper.classList.remove('show-controls');
    }, 3000);
});

// Close speed menu when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.speed-control')) {
        document.getElementById('speed-menu').classList.remove('show');
    }
});

// Double click to fullscreen
playerWrapper.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.player-controls') && !e.target.closest('.big-play-btn')) {
        toggleFullscreen();
    }
});

// ===== URL INPUT ENTER KEY =====
document.getElementById('video-url-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        loadVideo();
    }
});

// ===== ROOM CODE INPUT ENTER KEY =====
document.getElementById('room-code-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        checkRoomForJoin();
    }
});

// ===== MOBILE SIDEBAR TOGGLE =====
function toggleMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open');
}

// Close sidebar when clicking outside on mobile
document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('sidebar');
    if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
        if (!e.target.closest('.sidebar') && !e.target.closest('#toggle-sidebar-btn')) {
            sidebar.classList.remove('open');
        }
    }
});

// ===== HOST UI UPDATE =====
socket.on('host-status', (isHostFlag) => {
    isHost = isHostFlag;
    const hostBadge = document.getElementById('host-badge');
    const settingsBtn = document.getElementById('room-settings-btn');
    const clearQueueBtn = document.getElementById('clear-queue-btn');
    
    if (isHost) {
        if (hostBadge) hostBadge.classList.remove('hidden');
        if (settingsBtn) settingsBtn.style.display = 'flex';
        if (clearQueueBtn) clearQueueBtn.style.display = 'block';
        showToast("You are the host! 👑", "info");
    } else {
        if (hostBadge) hostBadge.classList.add('hidden');
        if (settingsBtn) settingsBtn.style.display = 'none';
    }
});

// ===== WINDOW BEFOREUNLOAD =====
window.addEventListener('beforeunload', () => {
    if (myStream) {
        myStream.getTracks().forEach(track => track.stop());
    }
});

// ===== FUTURISTIC PARTICLE SYSTEM =====
function initParticles() {
    const particlesContainer = document.getElementById('particles');
    if (!particlesContainer) return;
    
    const particleCount = 30;
    
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * 15 + 's';
        particle.style.animationDuration = (15 + Math.random() * 10) + 's';
        particle.style.opacity = 0.2 + Math.random() * 0.3;
        particle.style.width = (2 + Math.random() * 4) + 'px';
        particle.style.height = particle.style.width;
        particlesContainer.appendChild(particle);
    }
}

// Initialize particles when app container becomes visible
const appObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        if (mutation.target.id === 'app-container' && !mutation.target.classList.contains('hidden')) {
            initParticles();
            appObserver.disconnect();
        }
    });
});

const appContainer = document.getElementById('app-container');
if (appContainer) {
    appObserver.observe(appContainer, { attributes: true, attributeFilter: ['class'] });
}

// ===== VOLUME SLIDER TRACK UPDATE =====
function updateVolumeTrack() {
    const slider = document.getElementById('volume-slider');
    const track = document.querySelector('.volume-track');
    if (slider && track) {
        const percent = slider.value * 100;
        track.style.width = percent + '%';
    }
}

document.getElementById('volume-slider')?.addEventListener('input', updateVolumeTrack);

// Initialize volume track
updateVolumeTrack();

console.log("SyncWatch initialized! 🎬");
