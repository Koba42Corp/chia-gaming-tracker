/**
 * Production-Grade Gaming Tracker - HTTP Tracker Server
 * 
 * Secure, accessible tracker for game room discovery.
 * Built for Heroku deployment with production-grade security.
 * 
 * Security Features:
 * - Security headers (XSS, clickjacking, content type protection)
 * - Trust proxy for accurate IP detection
 * - Comprehensive input validation
 * - Replay attack prevention (nonce/timestamp)
 * - IP blocking for abuse
 * - Bounded rate limit maps
 * - Error handling without information leakage
 * - Request timeouts
 * - BitTorrent protocol compliance
 */

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ============================================================================
// CONFIGURATION
// ============================================================================

const TRACKER_ID = process.env.TRACKER_ID || crypto.randomBytes(20).toString('hex');
const PORT = process.env.PORT || 8766;
const ANNOUNCE_INTERVAL = 60; // Seconds
const MIN_ANNOUNCE_INTERVAL = 30; // Minimum interval
const PEER_TIMEOUT = process.env.PEER_TIMEOUT ? parseInt(process.env.PEER_TIMEOUT) : 600; // 10 minutes (rooms expire after this) - increased from 5 min
const MAX_ROOMS = 100; // Hard limit to prevent OOM

// Rate limiting
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
// Increased limits for development - polling every 5s = 12 requests/min, so we need higher limits
const RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) : 120; // Max requests per window (GET requests) - 2 per second
const RATE_LIMIT_MAX_ANNOUNCES = process.env.RATE_LIMIT_MAX_ANNOUNCES ? parseInt(process.env.RATE_LIMIT_MAX_ANNOUNCES) : 20; // Max POST requests per window - more lenient for room creation
const DISABLE_RATE_LIMIT = process.env.DISABLE_RATE_LIMIT === 'true'; // Allow disabling in dev
const rateLimitMap = new Map(); // IP -> { count, announceCount, resetTime, violations }
const MAX_RATE_LIMIT_ENTRIES = 1000; // Hard limit for rateLimitMap

// IP blocking (for abuse)
const BLOCKED_IPS = new Set(); // Can be populated from environment
const MAX_VIOLATIONS = process.env.MAX_VIOLATIONS ? parseInt(process.env.MAX_VIOLATIONS) : 10; // Block after this many violations (increased for dev)
const BLOCK_DURATION = process.env.BLOCK_DURATION ? parseInt(process.env.BLOCK_DURATION) : 5 * 60 * 1000; // 5 minutes block (reduced from 1 hour for dev)
const blockedIPs = new Map(); // IP -> { blockedUntil, reason }

// Nonce tracking (prevent replay attacks)
const usedNonces = new Set();
const NONCE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_NONCES = 5000; // Hard limit

// Request size limits
const MAX_REQUEST_SIZE = 10 * 1024; // 10KB max request body
const MAX_ROOM_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 50;

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Trust proxy for Heroku/X-Forwarded-For
app.set('trust proxy', true);

// Request size limits (prevent DoS)
app.use(express.json({ limit: MAX_REQUEST_SIZE }));
app.use(express.urlencoded({ extended: true, limit: MAX_REQUEST_SIZE }));

// Request timeout (prevent hanging requests)
server.setTimeout(30000); // 30 seconds

// Security headers
app.use((req, res, next) => {
  // XSS Protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Prevent clickjacking (allow iframe for embedding)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  
  // Content Security Policy (relaxed for iframe embedding)
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;");
  
  // HSTS (only on HTTPS)
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  next();
});

// CORS (with security considerations)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Check if IP is blocked
 */
function isIPBlocked(ip) {
  // Check permanent blocklist
  if (BLOCKED_IPS.has(ip)) {
    return { blocked: true, reason: 'Permanently blocked' };
  }
  
  // Check temporary blocks
  const blockInfo = blockedIPs.get(ip);
  if (blockInfo) {
    if (Date.now() < blockInfo.blockedUntil) {
      return { blocked: true, reason: blockInfo.reason };
    } else {
      // Block expired, remove it
      blockedIPs.delete(ip);
    }
  }
  return { blocked: false };
}

/**
 * Apply IP block
 */
function blockIP(ip, reason = 'Rate limit exceeded', duration = BLOCK_DURATION) {
  // Don't block localhost even if rate limited
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') {
    console.warn(`[SECURITY] Would block localhost ${ip} but skipping: ${reason}`);
    return;
  }
  
  blockedIPs.set(ip, {
    blockedUntil: Date.now() + duration,
    reason: reason
  });
  console.warn(`[SECURITY] IP ${ip} blocked for ${duration / 1000}s: ${reason}`);
}

/**
 * Get client IP address (handles proxies)
 */
function getClientIP(req) {
  return req.ip || 
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.connection.remoteAddress || 
         'unknown';
}

/**
 * Rate limiting middleware with IP blocking
 */
function rateLimit(req, res, next) {
  // Skip rate limiting if disabled (for development)
  if (DISABLE_RATE_LIMIT) {
    return next();
  }

  const ip = getClientIP(req);
  const now = Date.now();

  // Bypass rate limiting for localhost/127.0.0.1 in development
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') {
    // Still check for blocks, but don't rate limit localhost
    const blockStatus = isIPBlocked(ip);
    if (blockStatus.blocked) {
      console.warn(`[SECURITY] Blocked IP ${ip} access attempt: ${blockStatus.reason}`);
      return res.status(403).json({
        'failure reason': `Access denied: ${blockStatus.reason}`
      });
    }
    return next();
  }

  const blockStatus = isIPBlocked(ip);
  if (blockStatus.blocked) {
    console.warn(`[SECURITY] Blocked IP ${ip} access attempt: ${blockStatus.reason}`);
    return res.status(403).json({
      'failure reason': `Access denied: ${blockStatus.reason}`
    });
  }

  let rateLimitData = rateLimitMap.get(ip);
  
  if (!rateLimitData || now > rateLimitData.resetTime) {
    rateLimitData = {
      count: 0,
      announceCount: 0,
      resetTime: now + RATE_LIMIT_WINDOW,
      violations: 0
    };
    rateLimitMap.set(ip, rateLimitData);
  }

  // Enforce hard limit on rateLimitMap size
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    const entries = Array.from(rateLimitMap.entries())
      .sort((a, b) => a[1].resetTime - b[1].resetTime);
    const toRemove = rateLimitMap.size - MAX_RATE_LIMIT_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      rateLimitMap.delete(entries[i][0]);
    }
    console.warn(`[MEMORY] Rate limit map exceeded limit, removed ${toRemove} oldest entries`);
  }
  
  if (req.method === 'POST') {
    rateLimitData.announceCount++;
    if (rateLimitData.announceCount > RATE_LIMIT_MAX_ANNOUNCES) {
      rateLimitData.violations++;
      if (rateLimitData.violations >= MAX_VIOLATIONS) {
        blockIP(ip, 'Excessive announce attempts');
      }
      return res.status(429).json({
        'failure reason': `Too many announce requests. Try again in ${Math.ceil((rateLimitData.resetTime - now) / 1000)} seconds.`
      });
    }
  } else {
    rateLimitData.count++;
    if (rateLimitData.count > RATE_LIMIT_MAX_REQUESTS) {
      rateLimitData.violations++;
      if (rateLimitData.violations >= MAX_VIOLATIONS) {
        blockIP(ip, 'Excessive requests');
      }
      return res.status(429).json({
        'failure reason': `Too many requests. Try again in ${Math.ceil((rateLimitData.resetTime - now) / 1000)} seconds.`
      });
    }
  }
  next();
}

// ============================================================================
// STORAGE
// ============================================================================

const rooms = new Map(); // roomId -> room data

// ============================================================================
// VALIDATION & SECURITY
// ============================================================================

/**
 * Validate incoming room announcement data
 */
function validateAnnouncement(data) {
  const errors = [];

  // Validate roomId
  if (!data.roomId || typeof data.roomId !== 'string') {
    errors.push('Missing or invalid roomId');
  } else if (data.roomId.length > MAX_ROOM_ID_LENGTH) {
    errors.push(`roomId too long (max ${MAX_ROOM_ID_LENGTH} characters)`);
  } else if (!/^[a-zA-Z0-9_-]+$/.test(data.roomId)) {
    errors.push('roomId contains invalid characters (alphanumeric, dash, underscore only)');
  }
  
  // Validate gameType (can be null when status is 'waiting')
  const validGameTypes = ['rockpaperscissors', 'calpoker', 'battleship', 'tictactoe'];
  if (data.gameType !== null && data.gameType !== undefined) {
    if (typeof data.gameType !== 'string') {
      errors.push('Invalid gameType (must be string or null)');
    } else if (!validGameTypes.includes(data.gameType.toLowerCase())) {
      errors.push(`Invalid gameType. Must be one of: ${validGameTypes.join(', ')} or null`);
    }
  }
  // gameType can be null when status is 'waiting' - this is valid
  
  // Validate player1Name
  if (!data.player1Name || typeof data.player1Name !== 'string') {
    errors.push('Missing or invalid player1Name');
  } else if (data.player1Name.length > MAX_NAME_LENGTH) {
    errors.push(`player1Name too long (max ${MAX_NAME_LENGTH} characters)`);
  } else if (data.player1Name.trim().length === 0) {
    errors.push('player1Name cannot be empty');
  }
  
  // Validate wallet address (Chia address format)
  if (!data.player1WalletAddress || typeof data.player1WalletAddress !== 'string') {
    errors.push('Missing or invalid player1WalletAddress');
  } else if (!data.player1WalletAddress.startsWith('xch1') && !data.player1WalletAddress.startsWith('txch1')) {
    errors.push('Invalid wallet address format (must start with xch1 or txch1)');
  } else if (data.player1WalletAddress.length > 100) {
    errors.push('Wallet address too long');
  }
  
  // Validate wallet puzzle hash (optional but recommended)
  if (data.player1WalletPuzzleHash !== undefined && data.player1WalletPuzzleHash !== null) {
    if (typeof data.player1WalletPuzzleHash !== 'string') {
      errors.push('Invalid player1WalletPuzzleHash (must be string or null)');
    } else if (data.player1WalletPuzzleHash.length > 100) {
      errors.push('player1WalletPuzzleHash too long');
    }
  }
  
  // Validate public keys (optional but recommended)
  if (data.player1PublicKey !== undefined && data.player1PublicKey !== null) {
    if (typeof data.player1PublicKey !== 'string' || data.player1PublicKey.length > 200) {
      errors.push('Invalid player1PublicKey (must be string, max 200 chars)');
    }
  }
  
  if (data.player1IdentityPublicKey !== undefined && data.player1IdentityPublicKey !== null) {
    if (typeof data.player1IdentityPublicKey !== 'string' || data.player1IdentityPublicKey.length > 200) {
      errors.push('Invalid player1IdentityPublicKey (must be string, max 200 chars)');
    }
  }
  
  if (data.player1IdentityAddress !== undefined && data.player1IdentityAddress !== null) {
    if (typeof data.player1IdentityAddress !== 'string' || data.player1IdentityAddress.length > 100) {
      errors.push('Invalid player1IdentityAddress (must be string, max 100 chars)');
    }
  }
  
  // Validate peerId
  if (!data.player1PeerId || typeof data.player1PeerId !== 'string') {
    errors.push('Missing or invalid player1PeerId');
  } else if (data.player1PeerId.length > 200) {
    errors.push('player1PeerId too long (max 200 characters)');
  }
  
  // Validate appBaseUrl (required - tells other sites where to redirect for joining)
  if (!data.appBaseUrl || typeof data.appBaseUrl !== 'string') {
    errors.push('Missing or invalid appBaseUrl');
  } else {
    try {
      new URL(data.appBaseUrl);
    } catch {
      errors.push('appBaseUrl must be a valid URL');
    }
  }
  
  // Validate player2 fields (if provided, must be valid)
  if (data.player2Name !== undefined && data.player2Name !== null) {
    if (typeof data.player2Name !== 'string' || data.player2Name.length > MAX_NAME_LENGTH) {
      errors.push(`Invalid player2Name (must be string, max ${MAX_NAME_LENGTH} chars, or null)`);
    }
  }
  
  if (data.player2WalletAddress !== undefined && data.player2WalletAddress !== null) {
    if (typeof data.player2WalletAddress !== 'string') {
      errors.push('Invalid player2WalletAddress (must be string or null)');
    } else if (!data.player2WalletAddress.startsWith('xch1') && !data.player2WalletAddress.startsWith('txch1')) {
      errors.push('Invalid player2WalletAddress format (must start with xch1 or txch1)');
    }
  }
  
  // Validate state channel coin ID (optional)
  if (data.stateChannelCoinId !== undefined && data.stateChannelCoinId !== null) {
    if (typeof data.stateChannelCoinId !== 'string' || data.stateChannelCoinId.length > 100) {
      errors.push('Invalid stateChannelCoinId (must be string, max 100 chars, or null)');
    }
  }
  
  // Validate active game ID (optional)
  if (data.activeGameId !== undefined && data.activeGameId !== null) {
    if (typeof data.activeGameId !== 'string' || data.activeGameId.length > 200) {
      errors.push('Invalid activeGameId (must be string, max 200 chars, or null)');
    }
  }
  
  // Validate wager amount (if provided)
  if (data.wagerAmount !== undefined) {
    const wager = parseInt(data.wagerAmount);
    if (isNaN(wager) || wager < 0) {
      errors.push('Invalid wagerAmount (must be non-negative integer)');
    } else if (wager > 1000000000000) { // 1 trillion mojos (sanity check)
      errors.push('wagerAmount too large');
    }
  }
  
  // Validate status
  const validStatuses = ['waiting', 'active', 'finished', 'cancelled'];
  if (data.status && !validStatuses.includes(data.status)) {
    errors.push(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }
  
  // Validate public flag (optional, defaults to true)
  if (data.public !== undefined && typeof data.public !== 'boolean') {
    errors.push('Invalid public flag (must be boolean)');
  }
  
  // Validate timestamp (prevent replay attacks)
  if (data.timestamp) {
    const timeDiff = Math.abs(Date.now() - data.timestamp);
    if (timeDiff > 30000) { // 30 second tolerance
      errors.push('Request timestamp too far from server time');
    }
  }
  
  // Validate nonce (prevent duplicate announcements)
  if (data.nonce) {
    if (usedNonces.has(data.nonce)) {
      errors.push('Duplicate nonce (replay attack detected)');
    } else if (usedNonces.size >= MAX_NONCES) {
      // If nonce map is full, remove oldest entry before adding new one
      const oldestNonce = usedNonces.values().next().value;
      usedNonces.delete(oldestNonce);
      usedNonces.add(data.nonce);
    } else {
      usedNonces.add(data.nonce);
    }
    // Cleanup nonce after 5 minutes
    setTimeout(() => {
      usedNonces.delete(data.nonce);
    }, NONCE_CLEANUP_INTERVAL);
  }
  
  return errors;
}

/**
 * Sanitize search query to prevent injection
 */
function sanitizeSearch(query) {
  if (!query || typeof query !== 'string') return '';
  // Remove potentially dangerous characters, limit length
  return query.substring(0, 100).replace(/[<>\"']/g, '');
}

/**
 * Validate and sanitize query parameters
 */
function validateQueryParams(req) {
  const errors = [];
  
  // Validate offset
  if (req.query.offset !== undefined) {
    const offset = parseInt(req.query.offset);
    if (isNaN(offset) || offset < 0) {
      errors.push('Invalid offset (must be non-negative integer)');
    }
  }
  
  // Validate limit
  if (req.query.limit !== undefined) {
    const limit = parseInt(req.query.limit);
    if (isNaN(limit) || limit < 1 || limit > 200) {
      errors.push('Invalid limit (must be between 1 and 200)');
    }
  }
  
  // Validate minWager/maxWager
  if (req.query.minWager !== undefined) {
    const minWager = parseInt(req.query.minWager);
    if (isNaN(minWager) || minWager < 0) {
      errors.push('Invalid minWager (must be non-negative integer)');
    }
  }
  
  if (req.query.maxWager !== undefined) {
    const maxWager = parseInt(req.query.maxWager);
    if (isNaN(maxWager) || maxWager < 0) {
      errors.push('Invalid maxWager (must be non-negative integer)');
    }
  }
  
  // Validate includePrivate (optional boolean flag)
  if (req.query.includePrivate !== undefined) {
    const includePrivate = req.query.includePrivate;
    if (includePrivate !== 'true' && includePrivate !== 'false' && includePrivate !== '1' && includePrivate !== '0') {
      errors.push('Invalid includePrivate (must be true/false, 1/0)');
    }
  }
  
  return errors;
}

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * GET /health - Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tracker: TRACKER_ID,
    rooms: rooms.size,
    timestamp: Date.now()
  });
});

/**
 * GET /announce - List rooms
 * 
 * Query parameters (all optional):
 * - gameType: Filter by game type (e.g., 'rockpaperscissors', 'calpoker')
 * - status: Filter by status ('waiting', 'active', 'all')
 * - search: Text search in roomId, player names (case-insensitive)
 * - minWager: Minimum wager amount (mojos)
 * - maxWager: Maximum wager amount (mojos)
 * - sort: 'newest', 'oldest', 'wager_high', 'wager_low'
 * - offset: Pagination offset
 * - limit: Pagination limit (max 200)
 * - includePrivate: Include private rooms in results (default: false, set to 'true' to include)
 */
app.get('/announce', rateLimit, (req, res) => {
  try {
    // Validate query parameters
    const queryErrors = validateQueryParams(req);
    if (queryErrors.length > 0) {
      return res.status(400).json({
        'failure reason': queryErrors.join('; ')
      });
    }
    
    // Clean expired rooms (but also check updatedAt for active rooms)
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
      // Use updatedAt if available (room was recently updated), otherwise use createdAt
      const lastActivity = room.updatedAt || room.createdAt;
      if (lastActivity && (now - lastActivity > PEER_TIMEOUT * 1000)) {
        console.log(`[CLEANUP] Removing expired room: ${roomId} (last activity: ${new Date(lastActivity).toISOString()})`);
        rooms.delete(roomId);
      }
    }
    
    // Get and sanitize query parameters
    const gameType = req.query.gameType || 'all';
    const status = req.query.status || 'all';
    const search = sanitizeSearch(req.query.search);
    const minWager = parseInt(req.query.minWager) || 0;
    const maxWager = parseInt(req.query.maxWager) || Infinity;
    const sort = req.query.sort || 'newest';
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 200);
    const includePrivate = req.query.includePrivate === 'true' || req.query.includePrivate === '1';
    
    // Start with all non-expired rooms
    let roomList = Array.from(rooms.values());
    
    // Filter by public/private (exclude private rooms by default)
    if (!includePrivate) {
      roomList = roomList.filter(r => r.public !== false);
    }
    
    // Filter by game type
    if (gameType && gameType !== 'all') {
      roomList = roomList.filter(r => r.gameType === gameType);
    }
    
    // Filter by status
    if (status && status !== 'all') {
      roomList = roomList.filter(r => r.status === status);
    }
    
    // Filter by wager
    roomList = roomList.filter(r => {
      const wager = r.wagerAmount || 0;
      return wager >= minWager && wager <= maxWager;
    });
    
    // Search
    if (search) {
      const searchLower = search.toLowerCase();
      roomList = roomList.filter(r => 
        (r.roomId && r.roomId.toLowerCase().includes(searchLower)) ||
        (r.player1Name && r.player1Name.toLowerCase().includes(searchLower)) ||
        (r.player2Name && r.player2Name && r.player2Name.toLowerCase().includes(searchLower)) ||
        (r.player1?.name && r.player1.name.toLowerCase().includes(searchLower)) ||
        (r.player2?.name && r.player2.name && r.player2.name.toLowerCase().includes(searchLower))
      );
    }
    
    // Sort
    switch (sort) {
      case 'oldest':
        roomList.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case 'wager_high':
        roomList.sort((a, b) => (b.wagerAmount || 0) - (a.wagerAmount || 0));
        break;
      case 'wager_low':
        roomList.sort((a, b) => (a.wagerAmount || 0) - (b.wagerAmount || 0));
        break;
      case 'newest':
      default:
        roomList.sort((a, b) => b.createdAt - a.createdAt);
        break;
    }
    
    // Paginate
    const total = roomList.length;
    const paginatedRooms = roomList.slice(offset, offset + limit);
    
    // Response
    res.json({
      'tracker id': TRACKER_ID,
      'interval': ANNOUNCE_INTERVAL,
      'min interval': MIN_ANNOUNCE_INTERVAL,
      'complete': paginatedRooms.length,
      'incomplete': 0,
      'total': total,
      'offset': offset,
      'limit': limit,
      'rooms': paginatedRooms
    });
    
  } catch (error) {
    console.error('Error in GET /announce:', error);
    res.status(500).json({
      'failure reason': 'Internal server error'
    });
  }
});

/**
 * POST /announce - Announce a room
 */
app.post('/announce', rateLimit, (req, res) => {
  try {
    const data = req.body;
    
    // Validate
    const errors = validateAnnouncement(data);
    if (errors.length > 0) {
      return res.status(400).json({
        'failure reason': errors.join('; ')
      });
    }
    
    // Enforce room limit
    if (rooms.size >= MAX_ROOMS) {
      // Remove oldest room
      const sortedRooms = Array.from(rooms.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
      if (sortedRooms.length > 0) {
        rooms.delete(sortedRooms[0][0]);
      }
    }
    
    // Get or create room record
    let room = rooms.get(data.roomId);
    
    if (room) {
      // Update existing room - preserve createdAt, update all other fields
      room.gameType = data.gameType !== undefined ? data.gameType : room.gameType;
      room.status = data.status || room.status;
      
      // App base URL (can be updated)
      if (data.appBaseUrl) room.appBaseUrl = data.appBaseUrl;
      
      // Public flag (can be updated)
      if (data.public !== undefined) room.public = data.public;
      
      // Player 1 fields (can be updated)
      if (data.player1Name) room.player1Name = data.player1Name;
      if (data.player1WalletAddress) room.player1WalletAddress = data.player1WalletAddress;
      if (data.player1WalletPuzzleHash) room.player1WalletPuzzleHash = data.player1WalletPuzzleHash;
      if (data.player1PublicKey) room.player1PublicKey = data.player1PublicKey;
      if (data.player1IdentityPublicKey) room.player1IdentityPublicKey = data.player1IdentityPublicKey;
      if (data.player1IdentityAddress) room.player1IdentityAddress = data.player1IdentityAddress;
      if (data.player1PeerId) room.player1PeerId = data.player1PeerId;
      
      // Player 2 fields (can be updated)
      room.player2Name = data.player2Name !== undefined ? data.player2Name : room.player2Name;
      room.player2WalletAddress = data.player2WalletAddress !== undefined ? data.player2WalletAddress : room.player2WalletAddress;
      room.player2WalletPuzzleHash = data.player2WalletPuzzleHash !== undefined ? data.player2WalletPuzzleHash : room.player2WalletPuzzleHash;
      room.player2PublicKey = data.player2PublicKey !== undefined ? data.player2PublicKey : room.player2PublicKey;
      room.player2IdentityPublicKey = data.player2IdentityPublicKey !== undefined ? data.player2IdentityPublicKey : room.player2IdentityPublicKey;
      room.player2IdentityAddress = data.player2IdentityAddress !== undefined ? data.player2IdentityAddress : room.player2IdentityAddress;
      room.player2PeerId = data.player2PeerId !== undefined ? data.player2PeerId : room.player2PeerId;
      
      // State channel and game fields
      room.stateChannelCoinId = data.stateChannelCoinId !== undefined ? data.stateChannelCoinId : room.stateChannelCoinId;
      room.wagerAmount = data.wagerAmount !== undefined ? data.wagerAmount : room.wagerAmount;
      room.activeGameId = data.activeGameId !== undefined ? data.activeGameId : room.activeGameId;
      
      room.updatedAt = Date.now();
      console.log(`[TRACKER] Updated room: ${room.roomId} (status: ${room.status}, total rooms: ${rooms.size})`);
    } else {
      // Create new room - store all fields from announcement
      room = {
        roomId: data.roomId,
        gameType: data.gameType || null,
        status: data.status || 'waiting',
        appBaseUrl: data.appBaseUrl,
        public: data.public !== undefined ? data.public : true, // Default to true for backwards compatibility
        
        // Player 1 (required)
        player1Name: data.player1Name,
        player1WalletAddress: data.player1WalletAddress,
        player1WalletPuzzleHash: data.player1WalletPuzzleHash || null,
        player1PublicKey: data.player1PublicKey || null,
        player1IdentityPublicKey: data.player1IdentityPublicKey || null,
        player1IdentityAddress: data.player1IdentityAddress || null,
        player1PeerId: data.player1PeerId,
        
        // Player 2 (optional)
        player2Name: data.player2Name || null,
        player2WalletAddress: data.player2WalletAddress || null,
        player2WalletPuzzleHash: data.player2WalletPuzzleHash || null,
        player2PublicKey: data.player2PublicKey || null,
        player2IdentityPublicKey: data.player2IdentityPublicKey || null,
        player2IdentityAddress: data.player2IdentityAddress || null,
        player2PeerId: data.player2PeerId || null,
        
        // State channel
        stateChannelCoinId: data.stateChannelCoinId || null,
        
        // Game
        wagerAmount: data.wagerAmount || 0,
        activeGameId: data.activeGameId || null,
        
        // Timestamps
        createdAt: data.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      rooms.set(data.roomId, room);
      console.log(`[TRACKER] Created new room: ${room.roomId} (status: ${room.status}, total rooms: ${rooms.size})`);
    }
    
    // Response
    res.json({
      'tracker id': TRACKER_ID,
      'interval': ANNOUNCE_INTERVAL,
      'min interval': MIN_ANNOUNCE_INTERVAL,
      'complete': 1,
      'incomplete': 0,
      'room': room
    });
    
  } catch (error) {
    console.error('Error in POST /announce:', error);
    res.status(500).json({
      'failure reason': 'Internal server error'
    });
  }
});

/**
 * GET /scrape - Get tracker statistics
 */
app.get('/scrape', rateLimit, (req, res) => {
  try {
    const now = Date.now();
    
    // Clean expired rooms first (check both createdAt and updatedAt)
    for (const [roomId, room] of rooms.entries()) {
      const lastActivity = room.updatedAt || room.createdAt;
      if (lastActivity && (now - lastActivity > PEER_TIMEOUT * 1000)) {
        rooms.delete(roomId);
      }
    }
    
    const activeRooms = Array.from(rooms.values());
    
    // Calculate statistics
    let totalRooms = activeRooms.length;
    let waitingRooms = 0;
    let activeRoomsCount = 0;
    const roomsByGameType = {};
    const roomsByStatus = {};
    
    for (const room of activeRooms) {
      if (room.status === 'waiting') waitingRooms++;
      if (room.status === 'active') activeRoomsCount++;
      
      const gameType = room.gameType || 'unknown';
      roomsByGameType[gameType] = (roomsByGameType[gameType] || 0) + 1;
      
      const status = room.status || 'unknown';
      roomsByStatus[status] = (roomsByStatus[status] || 0) + 1;
    }
    
    res.json({
      'tracker id': TRACKER_ID,
      'files': {
        '_total': {
          'complete': totalRooms,
          'incomplete': 0
        },
        '_by_game_type': roomsByGameType,
        '_by_status': roomsByStatus
      }
    });
    
  } catch (error) {
    console.error('Error in GET /scrape:', error);
    res.status(500).json({
      'failure reason': 'Internal server error'
    });
  }
});

/**
 * GET / - API info or serve web UI
 */
app.get('/', (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  
  res.json({
    name: 'Gaming Tracker',
    version: '1.0.0',
    tracker: TRACKER_ID,
    endpoints: {
      'GET /health': 'Health check',
      'GET /announce': 'List rooms',
      'POST /announce': 'Announce room',
      'GET /scrape': 'Get statistics'
    }
  });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// Global error handler (no information leakage)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    'failure reason': 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    'failure reason': 'Endpoint not found'
  });
});

// ============================================================================
// CLEANUP & MAINTENANCE
// ============================================================================

// Clear any existing blocks for localhost on startup (for development)
function clearLocalhostBlocks() {
  const localhostIPs = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];
  let cleared = 0;
  
  for (const ip of localhostIPs) {
    if (blockedIPs.has(ip)) {
      blockedIPs.delete(ip);
      cleared++;
    }
    if (rateLimitMap.has(ip)) {
      rateLimitMap.delete(ip);
    }
  }
  
  if (cleared > 0) {
    console.log(`[DEV] Cleared ${cleared} localhost block(s) on startup`);
  }
}

// Clear localhost blocks on startup
clearLocalhostBlocks();

// Store interval IDs for cleanup (testing)
const cleanupIntervals = [];

// Cleanup expired rooms every minute
const roomCleanupInterval = setInterval(() => {
  const now = Date.now();
  let expiredCount = 0;
  
  for (const [roomId, room] of rooms.entries()) {
    // Use updatedAt if available (room was recently updated), otherwise use createdAt
    const lastActivity = room.updatedAt || room.createdAt;
    if (lastActivity && (now - lastActivity > PEER_TIMEOUT * 1000)) {
      console.log(`[CLEANUP] Removing expired room: ${roomId} (last activity: ${new Date(lastActivity).toISOString()}, age: ${Math.round((now - lastActivity) / 1000)}s)`);
      rooms.delete(roomId);
      expiredCount++;
    }
  }
  
  if (expiredCount > 0) {
    console.log(`[CLEANUP] Removed ${expiredCount} expired rooms`);
  }
  
  // Enforce hard limit
  const roomCount = rooms.size;
  if (roomCount > MAX_ROOMS) {
    const toRemove = roomCount - MAX_ROOMS;
    console.warn(`[MEMORY] Room limit exceeded: ${roomCount} > ${MAX_ROOMS}, removing ${toRemove} oldest rooms`);
    const sortedRooms = Array.from(rooms.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < toRemove && i < sortedRooms.length; i++) {
      const [roomId] = sortedRooms[i];
      rooms.delete(roomId);
    }
    console.log(`[MEMORY] Cleaned up to ${rooms.size} rooms`);
  } else if (roomCount > MAX_ROOMS * 0.8) {
    console.warn(`[MEMORY] Warning: ${roomCount} rooms (${Math.round(roomCount/MAX_ROOMS*100)}% of limit)`);
  }
}, 60 * 1000);
cleanupIntervals.push(roomCleanupInterval);

// Cleanup rate limit map periodically
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) {
      if (data.violations > 0) {
        data.violations = Math.max(0, data.violations - 1);
      } else {
        rateLimitMap.delete(ip);
      }
    }
  }
  // Hard limit on rate limit map is handled in rateLimit middleware
}, 5 * 60 * 1000);
cleanupIntervals.push(rateLimitCleanupInterval);

// Cleanup expired IP blocks
const ipBlockCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, blockInfo] of blockedIPs.entries()) {
    if (now >= blockInfo.blockedUntil) {
      blockedIPs.delete(ip);
      console.log(`[SECURITY] IP ${ip} block expired`);
    }
  }
  
  // Also clear localhost blocks periodically (safety net)
  const localhostIPs = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];
  for (const ip of localhostIPs) {
    if (blockedIPs.has(ip)) {
      blockedIPs.delete(ip);
      console.log(`[DEV] Cleared localhost block: ${ip}`);
    }
  }
}, 60 * 1000);
cleanupIntervals.push(ipBlockCleanupInterval);

// Cleanup function for testing
function cleanup() {
  cleanupIntervals.forEach(interval => clearInterval(interval));
  cleanupIntervals.length = 0;
}

// ============================================================================
// START SERVER
// ============================================================================

// Only start server if not in test mode
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  server.listen(PORT, () => {
    const serverUrl = process.env.DYNO 
      ? (process.env.DOMAIN || 'https://relay.crate.ink')
      : `http://localhost:${PORT}`;
    
    console.log('='.repeat(60));
    console.log('Production Gaming Tracker');
    console.log('='.repeat(60));
    console.log(`Server URL: ${serverUrl}`);
    console.log(`Tracker ID: ${TRACKER_ID}`);
    console.log(`Port: ${PORT}`);
    console.log(`Announce Interval: ${ANNOUNCE_INTERVAL}s`);
    console.log(`Min Interval: ${MIN_ANNOUNCE_INTERVAL}s`);
    console.log(`Peer Timeout: ${PEER_TIMEOUT}s`);
    console.log('='.repeat(60));
    console.log('Rate Limiting:');
    console.log(`  GET requests: ${RATE_LIMIT_MAX_REQUESTS}/min`);
    console.log(`  POST requests: ${RATE_LIMIT_MAX_ANNOUNCES}/min`);
    console.log(`  Localhost bypass: Enabled`);
    console.log(`  Rate limit disabled: ${DISABLE_RATE_LIMIT ? 'Yes' : 'No'}`);
    console.log('='.repeat(60));
    console.log('Endpoints:');
    console.log(`  GET  ${serverUrl}/           - Web UI or API info`);
    console.log(`  GET  ${serverUrl}/health     - Health check`);
    console.log(`  GET  ${serverUrl}/announce   - List rooms`);
    console.log(`  POST ${serverUrl}/announce   - Announce room`);
    console.log(`  GET  ${serverUrl}/scrape     - Statistics`);
    console.log('='.repeat(60));
    console.log('Security Features:');
    console.log('  ✓ Security headers (XSS, clickjacking, MIME protection)');
    console.log('  ✓ Trust proxy for accurate IP detection');
    console.log('  ✓ Rate limiting with IP blocking');
    console.log('  ✓ Replay attack prevention (nonce/timestamp)');
    console.log('  ✓ Input validation and sanitization');
    console.log('  ✓ Request size limits');
    console.log('  ✓ Memory bounds and cleanup');
    console.log('  ✓ Error handling without information leakage');
    console.log('='.repeat(60));
    console.log('Ready!');
  });
}

// Export for testing
module.exports = { app, server, cleanup };
