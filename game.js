// ============================================
// Circle World - Multiplayer Browser Game
// ============================================

const MAP_SIZE = 513;
const PLAYER_RADIUS = 15;
const PLAYER_SPEED = 200;
const BUBBLE_DURATION = 5000;
const SYNC_RATE = 50; // ms

// Game State
let peer = null;
let connections = new Map();
let isHost = false;
let hostConnection = null;

let localPlayer = null;
let players = new Map();
let chatMessages = [];

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const minimap = document.getElementById('minimap');
const minimapCtx = minimap.getContext('2d');

const usernameInput = document.getElementById('username-input');
const colorInput = document.getElementById('color-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const errorMsg = document.getElementById('error-msg');

const chatIcon = document.getElementById('chat-icon');
const chatInputContainer = document.getElementById('chat-input-container');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat');
const chatLog = document.getElementById('chat-log');

const roomCodeEl = document.getElementById('room-code');
const playerCountEl = document.getElementById('player-count');

// Input State
let keys = { up: false, down: false, left: false, right: false };
let joystickVector = { x: 0, y: 0 };
let lastTime = 0;

// ============================================
// Initialization
// ============================================

function init() {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Input Listeners
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    
    // Login
    joinBtn.addEventListener('click', joinGame);
    usernameInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') joinGame();
    });
    
    // Chat
    chatIcon.addEventListener('click', toggleChat);
    sendChatBtn.addEventListener('click', sendChat);
    chatInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') sendChat();
    });
    
    // Mobile Joystick
    setupJoystick();
    
    // Random color
    colorInput.value = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

// ============================================
// Join/Create Game
// ============================================

function joinGame() {
    const username = usernameInput.value.trim();
    const color = colorInput.value;
    const roomCode = roomInput.value.trim().toUpperCase();
    
    if (!username) {
        showError('Please enter a username');
        return;
    }
    
    if (username.length < 2) {
        showError('Username must be at least 2 characters');
        return;
    }
    
    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting...';
    errorMsg.textContent = '';
    
    // Create local player
    localPlayer = {
        id: null,
        username: username,
        color: color,
        x: Math.random() * (MAP_SIZE - 100) + 50,
        y: Math.random() * (MAP_SIZE - 100) + 50,
        bubble: null
    };
    
    if (roomCode) {
        // Join existing room
        joinRoom(roomCode);
    } else {
        // Create new room
        createRoom();
    }
}

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = 'CW-';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function createRoom() {
    const roomCode = generateRoomCode();
    isHost = true;
    
    peer = new Peer(roomCode, {
        debug: 1
    });
    
    peer.on('open', id => {
        localPlayer.id = id;
        players.set(id, localPlayer);
        startGame(roomCode);
    });
    
    peer.on('connection', conn => {
        handleNewConnection(conn);
    });
    
    peer.on('error', err => {
        if (err.type === 'unavailable-id') {
            // Room code taken, try again
            peer.destroy();
            createRoom();
        } else {
            showError('Connection error: ' + err.type);
            resetLogin();
        }
    });
}

function joinRoom(roomCode) {
    isHost = false;
    
    peer = new Peer({
        debug: 1
    });
    
    peer.on('open', id => {
        localPlayer.id = id;
        
        const conn = peer.connect(roomCode, { reliable: true });
        
        conn.on('open', () => {
            hostConnection = conn;
            
            // Send join request
            conn.send({
                type: 'join',
                player: {
                    id: localPlayer.id,
                    username: localPlayer.username,
                    color: localPlayer.color,
                    x: localPlayer.x,
                    y: localPlayer.y
                }
            });
        });
        
        conn.on('data', data => handleHostMessage(data));
        
        conn.on('close', () => {
            showError('Disconnected from host');
            location.reload();
        });
        
        conn.on('error', err => {
            showError('Connection error');
            resetLogin();
        });
    });
    
    peer.on('error', err => {
        if (err.type === 'peer-unavailable') {
            showError('Room not found: ' + roomCode);
        } else {
            showError('Connection error: ' + err.type);
        }
        resetLogin();
    });
}

function handleNewConnection(conn) {
    conn.on('open', () => {
        connections.set(conn.peer, conn);
    });
    
    conn.on('data', data => handlePeerMessage(conn, data));
    
    conn.on('close', () => {
        const playerId = conn.peer;
        connections.delete(playerId);
        players.delete(playerId);
        broadcastPlayers();
        updatePlayerCount();
    });
}

function handlePeerMessage(conn, data) {
    switch (data.type) {
        case 'join':
            // Check for duplicate username
            let isDuplicate = false;
            players.forEach(p => {
                if (p.username.toLowerCase() === data.player.username.toLowerCase()) {
                    isDuplicate = true;
                }
            });
            
            if (isDuplicate) {
                conn.send({ type: 'error', message: 'Username already taken' });
                conn.close();
                return;
            }
            
            // Add new player
            players.set(data.player.id, data.player);
            
            // Send current state to new player
            conn.send({
                type: 'init',
                players: Array.from(players.values()),
                roomCode: peer.id
            });
            
            // Broadcast to all
            broadcastPlayers();
            updatePlayerCount();
            break;
            
        case 'update':
            if (players.has(data.id)) {
                const player = players.get(data.id);
                player.x = data.x;
                player.y = data.y;
                broadcastPlayers();
            }
            break;
            
        case 'chat':
            if (players.has(data.id)) {
                const player = players.get(data.id);
                player.bubble = { text: data.message, time: Date.now() };
                addChatMessage(player.username, data.message, player.color);
                broadcastChat(data.id, data.message);
            }
            break;
    }
}

function handleHostMessage(data) {
    switch (data.type) {
        case 'init':
            data.players.forEach(p => {
                players.set(p.id, p);
            });
            startGame(data.roomCode);
            break;
            
        case 'players':
            const localData = players.get(localPlayer.id);
            players.clear();
            data.players.forEach(p => {
                if (p.id === localPlayer.id) {
                    // Keep local position
                    p.x = localPlayer.x;
                    p.y = localPlayer.y;
                }
                players.set(p.id, p);
            });
            updatePlayerCount();
            break;
            
        case 'chat':
            if (players.has(data.id)) {
                const player = players.get(data.id);
                player.bubble = { text: data.message, time: Date.now() };
                addChatMessage(player.username, data.message, player.color);
            }
            break;
            
        case 'error':
            showError(data.message);
            resetLogin();
            break;
    }
}

function broadcastPlayers() {
    const playersData = Array.from(players.values()).map(p => ({
        id: p.id,
        username: p.username,
        color: p.color,
        x: p.x,
        y: p.y,
        bubble: p.bubble
    }));
    
    connections.forEach(conn => {
        conn.send({ type: 'players', players: playersData });
    });
}

function broadcastChat(senderId, message) {
    connections.forEach(conn => {
        conn.send({ type: 'chat', id: senderId, message: message });
    });
}

// ============================================
// Game Loop
// ============================================

function startGame(roomCode) {
    loginScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    
    roomCodeEl.textContent = 'Room: ' + roomCode;
    updatePlayerCount();
    
    // Start game loop
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
    
    // Start sync
    setInterval(syncPosition, SYNC_RATE);
}

function gameLoop(currentTime) {
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;
    
    update(deltaTime);
    render();
    
    requestAnimationFrame(gameLoop);
}

function update(dt) {
    if (!localPlayer) return;
    
    // Calculate movement
    let dx = 0, dy = 0;
    
    if (keys.up) dy -= 1;
    if (keys.down) dy += 1;
    if (keys.left) dx -= 1;
    if (keys.right) dx += 1;
    
    // Add joystick input
    dx += joystickVector.x;
    dy += joystickVector.y;
    
    // Normalize
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length > 0) {
        dx /= length;
        dy /= length;
    }
    
    // Apply movement
    localPlayer.x += dx * PLAYER_SPEED * dt;
    localPlayer.y += dy * PLAYER_SPEED * dt;
    
    // Clamp to map bounds
    localPlayer.x = Math.max(PLAYER_RADIUS, Math.min(MAP_SIZE - PLAYER_RADIUS, localPlayer.x));
    localPlayer.y = Math.max(PLAYER_RADIUS, Math.min(MAP_SIZE - PLAYER_RADIUS, localPlayer.y));
    
    // Update in players map
    if (players.has(localPlayer.id)) {
        players.get(localPlayer.id).x = localPlayer.x;
        players.get(localPlayer.id).y = localPlayer.y;
    }
    
    // Clear expired bubbles
    players.forEach(player => {
        if (player.bubble && Date.now() - player.bubble.time > BUBBLE_DURATION) {
            player.bubble = null;
        }
    });
}

function syncPosition() {
    if (!localPlayer) return;
    
    if (isHost) {
        broadcastPlayers();
    } else if (hostConnection) {
        hostConnection.send({
            type: 'update',
            id: localPlayer.id,
            x: localPlayer.x,
            y: localPlayer.y
        });
    }
}

// ============================================
// Rendering
// ============================================

function render() {
    // Clear
    ctx.fillStyle = '#2d3436';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Camera
    const camX = localPlayer.x - canvas.width / 2;
    const camY = localPlayer.y - canvas.height / 2;
    
    ctx.save();
    ctx.translate(-camX, -camY);
    
    // Draw grid
    drawGrid(camX, camY);
    
    // Draw map bounds
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE);
    
    // Draw players
    players.forEach(player => {
        drawPlayer(player);
    });
    
    ctx.restore();
    
    // Draw minimap
    renderMinimap();
}

function drawGrid(camX, camY) {
    const gridSize = 50;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    
    const startX = Math.floor(camX / gridSize) * gridSize;
    const startY = Math.floor(camY / gridSize) * gridSize;
    
    for (let x = startX; x < camX + canvas.width + gridSize; x += gridSize) {
        if (x >= 0 && x <= MAP_SIZE) {
            ctx.beginPath();
            ctx.moveTo(x, Math.max(0, camY));
            ctx.lineTo(x, Math.min(MAP_SIZE, camY + canvas.height));
            ctx.stroke();
        }
    }
    
    for (let y = startY; y < camY + canvas.height + gridSize; y += gridSize) {
        if (y >= 0 && y <= MAP_SIZE) {
            ctx.beginPath();
            ctx.moveTo(Math.max(0, camX), y);
            ctx.lineTo(Math.min(MAP_SIZE, camX + canvas.width), y);
            ctx.stroke();
        }
    }
}

function drawPlayer(player) {
    // Shadow
    ctx.beginPath();
    ctx.arc(player.x + 3, player.y + 3, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fill();
    
    // Body
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Highlight
    ctx.beginPath();
    ctx.arc(player.x - 5, player.y - 5, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fill();
    
    // Username
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText(player.username, player.x, player.y - PLAYER_RADIUS - 10);
    ctx.fillText(player.username, player.x, player.y - PLAYER_RADIUS - 10);
    
    // Speech bubble
    if (player.bubble) {
        drawBubble(player.x, player.y - PLAYER_RADIUS - 35, player.bubble.text);
    }
}

function drawBubble(x, y, text) {
    const padding = 10;
    ctx.font = '13px sans-serif';
    const metrics = ctx.measureText(text);
    const width = Math.min(metrics.width + padding * 2, 200);
    const height = 30;
    
    // Wrap text if needed
    const maxWidth = 180;
    let displayText = text;
    if (metrics.width > maxWidth) {
        displayText = text.substring(0, 25) + '...';
    }
    
    // Bubble background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.beginPath();
    ctx.roundRect(x - width/2, y - height, width, height, 10);
    ctx.fill();
    
    // Pointer
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x + 8, y);
    ctx.lineTo(x, y + 10);
    ctx.closePath();
    ctx.fill();
    
    // Text
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.fillText(displayText, x, y - height/2 + 5);
}

function renderMinimap() {
    const scale = 150 / MAP_SIZE;
    
    minimapCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    minimapCtx.fillRect(0, 0, 150, 150);
    
    // Draw players as dots
    players.forEach(player => {
        const mx = player.x * scale;
        const my = player.y * scale;
        const isLocal = player.id === localPlayer.id;
        
        minimapCtx.beginPath();
        minimapCtx.arc(mx, my, isLocal ? 5 : 3, 0, Math.PI * 2);
        minimapCtx.fillStyle = player.color;
        minimapCtx.fill();
        
        if (isLocal) {
            minimapCtx.strokeStyle = '#fff';
            minimapCtx.lineWidth = 2;
            minimapCtx.stroke();
        }
    });
    
    // Draw viewport rectangle
    const vx = (localPlayer.x - canvas.width/2) * scale;
    const vy = (localPlayer.y - canvas.height/2) * scale;
    const vw = canvas.width * scale;
    const vh = canvas.height * scale;
    
    minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(vx, vy, vw, vh);
}

// ============================================
// Chat
// ============================================

function toggleChat() {
    chatInputContainer.classList.toggle('hidden');
    if (!chatInputContainer.classList.contains('hidden')) {
        chatInput.focus();
    }
}

function sendChat() {
    const message = chatInput.value.trim();
    if (!message) return;
    
    // Set local bubble
    localPlayer.bubble = { text: message, time: Date.now() };
    if (players.has(localPlayer.id)) {
        players.get(localPlayer.id).bubble = localPlayer.bubble;
    }
    
    // Add to log
    addChatMessage(localPlayer.username, message, localPlayer.color);
    
    // Send to others
    if (isHost) {
        broadcastChat(localPlayer.id, message);
    } else if (hostConnection) {
        hostConnection.send({
            type: 'chat',
            id: localPlayer.id,
            message: message
        });
    }
    
    chatInput.value = '';
    chatInputContainer.classList.add('hidden');
}

function addChatMessage(sender, message, color) {
    const div = document.createElement('div');
    div.className = 'chat-message';
    div.innerHTML = `<span class="sender" style="color: ${color}">${sender}:</span>${escapeHtml(message)}`;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    
    // Limit chat history
    while (chatLog.children.length > 50) {
        chatLog.removeChild(chatLog.firstChild);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Input Handling
// ============================================

function handleKeyDown(e) {
    if (document.activeElement === chatInput || document.activeElement === usernameInput || document.activeElement === roomInput) {
        return;
    }
    
    switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': keys.up = true; break;
        case 'ArrowDown': case 's': case 'S': keys.down = true; break;
        case 'ArrowLeft': case 'a': case 'A': keys.left = true; break;
        case 'ArrowRight': case 'd': case 'D': keys.right = true; break;
        case 'Enter':
            if (!loginScreen.classList.contains('hidden')) return;
            toggleChat();
            e.preventDefault();
            break;
    }
}

function handleKeyUp(e) {
    switch (e.key) {
        case 'ArrowUp': case 'w': case 'W': keys.up = false; break;
        case 'ArrowDown': case 's': case 'S': keys.down = false; break;
        case 'ArrowLeft': case 'a': case 'A': keys.left = false; break;
        case 'ArrowRight': case 'd': case 'D': keys.right = false; break;
    }
}

function setupJoystick() {
    const joystick = document.getElementById('joystick');
    const knob = document.getElementById('joystick-knob');
    const container = document.getElementById('joystick-container');
    
    let touching = false;
    let centerX, centerY;
    const maxDistance = 35;
    
    function handleStart(e) {
        e.preventDefault();
        touching = true;
        const rect = joystick.getBoundingClientRect();
        centerX = rect.left + rect.width / 2;
        centerY = rect.top + rect.height / 2;
    }
    
    function handleMove(e) {
        if (!touching) return;
        e.preventDefault();
        
        const touch = e.touches ? e.touches[0] : e;
        let dx = touch.clientX - centerX;
        let dy = touch.clientY - centerY;
        
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > maxDistance) {
            dx = (dx / distance) * maxDistance;
            dy = (dy / distance) * maxDistance;
        }
        
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        
        joystickVector.x = dx / maxDistance;
        joystickVector.y = dy / maxDistance;
    }
    
    function handleEnd() {
        touching = false;
        knob.style.transform = 'translate(0, 0)';
        joystickVector.x = 0;
        joystickVector.y = 0;
    }
    
    joystick.addEventListener('touchstart', handleStart);
    joystick.addEventListener('mousedown', handleStart);
    
    document.addEventListener('touchmove', handleMove);
    document.addEventListener('mousemove', handleMove);
    
    document.addEventListener('touchend', handleEnd);
    document.addEventListener('mouseup', handleEnd);
}

// ============================================
// Utilities
// ============================================

function updatePlayerCount() {
    playerCountEl.textContent = `Players: ${players.size}`;
}

function showError(msg) {
    errorMsg.textContent = msg;
}

function resetLogin() {
    joinBtn.disabled = false;
    joinBtn.textContent = 'Play';
    if (peer) peer.destroy();
}

// Start the game
init();
