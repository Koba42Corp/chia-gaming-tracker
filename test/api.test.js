/**
 * API Integration Tests
 * 
 * Tests for all tracker API endpoints:
 * - GET /health
 * - GET /announce (list rooms)
 * - POST /announce (create/update room)
 * - GET /scrape (statistics)
 */

const request = require('supertest');

let app;
let server;
let cleanup;

beforeAll(() => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  process.env.PORT = '8767';
  process.env.DISABLE_RATE_LIMIT = 'true';
  
  // Clear modules cache to get fresh instance
  delete require.cache[require.resolve('../index.js')];
  
  // Import app, server, and cleanup function
  const tracker = require('../index.js');
  app = tracker.app;
  server = tracker.server;
  cleanup = tracker.cleanup;
  
  // Start server on test port
  if (!server.listening) {
    server.listen(8767);
  }
});

afterAll(async () => {
  // Clean up intervals
  if (cleanup) {
    cleanup();
  }
  
  // Close server
  if (server && server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  
  // Clean up environment
  delete process.env.NODE_ENV;
  delete process.env.PORT;
  delete process.env.DISABLE_RATE_LIMIT;
  
  // Clear module cache
  delete require.cache[require.resolve('../index.js')];
});

describe('Health Check', () => {
  test('GET /health returns 200 with status ok', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('tracker');
    expect(response.body).toHaveProperty('rooms');
    expect(response.body).toHaveProperty('timestamp');
    expect(typeof response.body.timestamp).toBe('number');
  });
});

describe('POST /announce - Create Room', () => {
  const validRoomData = {
    roomId: 'test-room-123',
    appBaseUrl: 'https://crate.ink',
    public: true,
    gameType: 'rockpaperscissors',
    status: 'waiting',
    player1Name: 'TestPlayer',
    player1WalletAddress: 'xch1test1234567890123456789012345678901234567890',
    player1PeerId: 'peer-test-123'
  };

  test('creates a new room with valid data', async () => {
    const response = await request(app)
      .post('/announce')
      .send(validRoomData)
      .expect(200);
    
    expect(response.body).toHaveProperty('tracker id');
    expect(response.body).toHaveProperty('room');
    expect(response.body.room.roomId).toBe(validRoomData.roomId);
    expect(response.body.room.public).toBe(true);
    expect(response.body.room.appBaseUrl).toBe(validRoomData.appBaseUrl);
  });

  test('rejects missing required fields', async () => {
    const invalidData = { ...validRoomData };
    delete invalidData.roomId;
    
    const response = await request(app)
      .post('/announce')
      .send(invalidData)
      .expect(400);
    
    expect(response.body).toHaveProperty('failure reason');
    expect(response.body['failure reason']).toContain('roomId');
  });

  test('rejects invalid wallet address format', async () => {
    const invalidData = {
      ...validRoomData,
      roomId: 'test-room-invalid-wallet',
      player1WalletAddress: 'invalid-address'
    };
    
    const response = await request(app)
      .post('/announce')
      .send(invalidData)
      .expect(400);
    
    expect(response.body['failure reason']).toContain('wallet address');
  });

  test('rejects invalid appBaseUrl', async () => {
    const invalidData = {
      ...validRoomData,
      roomId: 'test-room-invalid-url',
      appBaseUrl: 'not-a-url'
    };
    
    const response = await request(app)
      .post('/announce')
      .send(invalidData)
      .expect(400);
    
    expect(response.body['failure reason']).toContain('appBaseUrl');
  });

  test('creates private room when public is false', async () => {
    const privateRoom = {
      ...validRoomData,
      roomId: 'private-room-456',
      public: false
    };
    
    const response = await request(app)
      .post('/announce')
      .send(privateRoom)
      .expect(200);
    
    expect(response.body.room.public).toBe(false);
  });

  test('updates existing room with same roomId', async () => {
    const roomId = `update-test-${Date.now()}`;
    
    // Create room
    const createResponse = await request(app)
      .post('/announce')
      .send({ ...validRoomData, roomId })
      .expect(200);
    
    expect(createResponse.body.room.status).toBe('waiting');
    
    // Update room
    const updateData = {
      ...validRoomData,
      roomId,
      status: 'active',
      player2Name: 'Player2',
      player2WalletAddress: 'xch1player2test123456789012345678901234567890',
      player2PeerId: 'peer-test-456'
    };
    
    const updateResponse = await request(app)
      .post('/announce')
      .send(updateData)
      .expect(200);
    
    expect(updateResponse.body.room.status).toBe('active');
    expect(updateResponse.body.room.player2Name).toBe('Player2');
    // createdAt should be preserved
    expect(updateResponse.body.room.createdAt).toBe(createResponse.body.room.createdAt);
  });
});

describe('GET /announce - List Rooms', () => {
  // Create test rooms before each test
  const testRooms = [
    {
      roomId: `test-room-1-${Date.now()}`,
      appBaseUrl: 'https://crate.ink',
      public: true,
      gameType: 'rockpaperscissors',
      status: 'waiting',
      player1Name: 'Player1',
      player1WalletAddress: 'xch1test1111111111111111111111111111111111111111',
      player1PeerId: 'peer-1',
      wagerAmount: 1000000
    },
    {
      roomId: `test-room-2-${Date.now()}`,
      appBaseUrl: 'https://crate.ink',
      public: true,
      gameType: 'calpoker',
      status: 'active',
      player1Name: 'Player2',
      player1WalletAddress: 'xch1test2222222222222222222222222222222222222222',
      player1PeerId: 'peer-2',
      wagerAmount: 5000000
    },
    {
      roomId: `test-room-3-private-${Date.now()}`,
      appBaseUrl: 'https://crate.ink',
      public: false, // Private room
      gameType: 'battleship',
      status: 'waiting',
      player1Name: 'Player3',
      player1WalletAddress: 'xch1test3333333333333333333333333333333333333333',
      player1PeerId: 'peer-3'
    }
  ];

  beforeEach(async () => {
    // Create test rooms
    for (const room of testRooms) {
      await request(app).post('/announce').send(room);
    }
    
    // Small delay to ensure rooms are processed
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('returns all public rooms by default', async () => {
    const response = await request(app)
      .get('/announce')
      .expect(200);
    
    expect(response.body).toHaveProperty('rooms');
    expect(Array.isArray(response.body.rooms)).toBe(true);
    expect(response.body).toHaveProperty('total');
    expect(response.body).toHaveProperty('offset');
    expect(response.body).toHaveProperty('limit');
    
    // Should only return public rooms (public !== false)
    response.body.rooms.forEach(room => {
      expect(room.public).not.toBe(false);
    });
  });

  test('filters by gameType', async () => {
    const response = await request(app)
      .get('/announce?gameType=rockpaperscissors')
      .expect(200);
    
    response.body.rooms.forEach(room => {
      expect(room.gameType).toBe('rockpaperscissors');
    });
  });

  test('filters by status', async () => {
    const response = await request(app)
      .get('/announce?status=waiting')
      .expect(200);
    
    response.body.rooms.forEach(room => {
      expect(room.status).toBe('waiting');
    });
  });

  test('includes private rooms when includePrivate=true', async () => {
    const response = await request(app)
      .get('/announce?includePrivate=true')
      .expect(200);
    
    const hasPrivateRoom = response.body.rooms.some(room => room.public === false);
    expect(hasPrivateRoom).toBe(true);
  });

  test('searches by player name', async () => {
    const response = await request(app)
      .get('/announce?search=Player1')
      .expect(200);
    
    const found = response.body.rooms.some(room => 
      room.player1Name && room.player1Name.toLowerCase().includes('player1')
    );
    expect(found).toBe(true);
  });

  test('filters by wager range', async () => {
    const response = await request(app)
      .get('/announce?minWager=2000000&maxWager=10000000')
      .expect(200);
    
    response.body.rooms.forEach(room => {
      const wager = room.wagerAmount || 0;
      expect(wager).toBeGreaterThanOrEqual(2000000);
      expect(wager).toBeLessThanOrEqual(10000000);
    });
  });

  test('paginates results', async () => {
    const response = await request(app)
      .get('/announce?offset=0&limit=1')
      .expect(200);
    
    expect(response.body.rooms.length).toBeLessThanOrEqual(1);
    expect(response.body).toHaveProperty('offset', 0);
    expect(response.body).toHaveProperty('limit', 1);
    expect(response.body).toHaveProperty('total');
  });

  test('sorts by newest by default', async () => {
    const response = await request(app)
      .get('/announce')
      .expect(200);
    
    if (response.body.rooms.length > 1) {
      const first = response.body.rooms[0].createdAt;
      const second = response.body.rooms[1].createdAt;
      expect(first).toBeGreaterThanOrEqual(second);
    }
  });

  test('validates query parameters', async () => {
    const response = await request(app)
      .get('/announce?limit=300') // Exceeds max of 200
      .expect(400);
    
    expect(response.body).toHaveProperty('failure reason');
  });
});

describe('GET /scrape - Statistics', () => {
  test('returns tracker statistics', async () => {
    const response = await request(app)
      .get('/scrape')
      .expect(200);
    
    expect(response.body).toHaveProperty('tracker id');
    expect(response.body).toHaveProperty('files');
    expect(response.body.files).toHaveProperty('_total');
    expect(response.body.files._total).toHaveProperty('complete');
    expect(response.body.files).toHaveProperty('_by_game_type');
    expect(response.body.files).toHaveProperty('_by_status');
  });
});

describe('Error Handling', () => {
  test('returns 404 for unknown endpoints', async () => {
    const response = await request(app)
      .get('/unknown-endpoint')
      .expect(404);
    
    expect(response.body).toHaveProperty('failure reason');
  });
});
