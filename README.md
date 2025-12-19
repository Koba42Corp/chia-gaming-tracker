# Chia Gaming Tracker Server

HTTP tracker server for Chia gaming room discovery. Built for secure, accessible game room discovery with support for public and private rooms.

## Overview

This tracker provides a simple, open HTTP API that any website can query to discover available game rooms. It enables cross-site interoperability - any site can display available game rooms and redirect users to join via the originating app's URL.

**Key Features:**
- **Simple HTTP API** - Clean GET/POST endpoints for room discovery and management
- **Public & Private Rooms** - Control room discoverability (public rooms appear in listings, private rooms require direct room ID)
- **Cross-Site Joining** - `appBaseUrl` field enables any site to redirect users to join rooms
- **Enterprise Security** - Rate limiting, IP blocking, comprehensive input validation
- **Comprehensive Search & Filtering** - Text search, wager ranges, game types, status filtering
- **Open & Interoperable** - No authentication required, works with any client
- **Fast & Scalable** - In-memory storage with automatic cleanup

## Architecture

### Single-Relay Design

The tracker operates as a standalone HTTP server:

- Stores rooms in-memory for fast access
- Accepts client requests via HTTP endpoints
- Automatic cleanup of expired rooms
- Production-ready security features

### API Design

The tracker provides simple HTTP endpoints:

- **GET /announce** - List available rooms with filtering and search
- **POST /announce** - Announce/update a room
- **GET /scrape** - Get tracker statistics
- **GET /health** - Health check endpoint

## Installation

```bash
npm install
```

## Configuration

### Environment Variables

```bash
# Server
PORT=8766  # Default: 8766 (Heroku sets this automatically)

# Tracker Identity
TRACKER_ID=your-unique-tracker-id  # Auto-generated if not set

# Room Expiration
PEER_TIMEOUT=600  # Room expiration time in seconds (default: 600 = 10 minutes)

# Rate Limiting
RATE_LIMIT_MAX_REQUESTS=120  # GET requests per minute (default: 120)
RATE_LIMIT_MAX_ANNOUNCES=20  # POST requests per minute (default: 20)
DISABLE_RATE_LIMIT=false  # Set to 'true' to disable rate limiting (dev only)

# IP Blocking
MAX_VIOLATIONS=10  # Violations before IP block (default: 10)
BLOCK_DURATION=300000  # Block duration in milliseconds (default: 300000 = 5 minutes)
```

## API Endpoints

### GET /announce - List Available Rooms

Query available game rooms with comprehensive filtering and search. **Private rooms are excluded by default.**

**Query Parameters (all optional):**
- `gameType` - Filter by game type (`rockpaperscissors`, `calpoker`, `battleship`, `tictactoe`, or `all`)
- `status` - Filter by status (`waiting`, `active`, `finished`, `cancelled`, or `all`)
- `search` - Text search in roomId, player names (case-insensitive, max 100 chars)
- `minWager` - Minimum wager amount (mojos)
- `maxWager` - Maximum wager amount (mojos)
- `sort` - Sort order (`newest`, `oldest`, `wager_high`, `wager_low`)
- `offset` - Pagination offset (default: 0)
- `limit` - Maximum results (default: 50, max: 200)
- `includePrivate` - Include private rooms (`true`/`false`, `1`/`0`, default: `false`)

**Examples:**
```bash
# Get all waiting Rock Paper Scissors rooms
curl "https://relay.crate.ink/announce?gameType=rockpaperscissors&status=waiting"

# Search for high-stakes games
curl "https://relay.crate.ink/announce?minWager=10000000&sort=wager_high&limit=10"

# Search by player name
curl "https://relay.crate.ink/announce?search=alice"

# Include private rooms (admin/view-all)
curl "https://relay.crate.ink/announce?includePrivate=true"
```

**Response:**
```json
{
  "tracker id": "abc123...",
  "interval": 60,
  "min interval": 30,
  "complete": 42,
  "incomplete": 0,
  "total": 100,
  "offset": 0,
  "limit": 50,
  "rooms": [
    {
      "roomId": "room-123",
      "gameType": "rockpaperscissors",
      "status": "waiting",
      "appBaseUrl": "https://crate.ink",
      "public": true,
      "player1Name": "Alice",
      "player1WalletAddress": "xch1...",
      "player1PeerId": "peer-123",
      "wagerAmount": 1000000,
      "createdAt": 1234567890123,
      "updatedAt": 1234567890123
    }
  ]
}
```

### POST /announce - Announce a Room

Announce a new game room or update an existing one. The same endpoint is used for both creating and updating rooms (determined by `roomId`).

**Required Fields:**
- `roomId` - Unique room identifier (alphanumeric, dash, underscore only, max 100 chars)
- `appBaseUrl` - Base URL of your app (e.g., `"https://crate.ink"`). Required for cross-site joining
- `player1Name` - Room creator's name (max 50 chars)
- `player1WalletAddress` - Chia wallet address (must start with `xch1` or `txch1`)
- `player1PeerId` - PeerJS peer ID (max 200 chars)

**Optional Fields:**
- `public` - Boolean, default `true`. Set to `false` for private rooms (hidden from browse listings)
- `gameType` - Game type: `rockpaperscissors`, `calpoker`, `battleship`, `tictactoe`, or `null`
- `status` - Room status: `waiting`, `active`, `finished`, `cancelled` (default: `waiting`)
- `player2Name`, `player2WalletAddress`, `player2PeerId` - Player 2 fields (when joined)
- `wagerAmount` - Wager amount in mojos (default: 0)
- `stateChannelCoinId` - State channel coin ID
- `activeGameId` - Active game ID
- `player1WalletPuzzleHash`, `player1PublicKey`, etc. - Additional player fields (recommended)
- `timestamp`, `nonce` - For replay attack prevention

**Request Example (Create Public Room):**
```json
{
  "roomId": "unique-room-id",
  "appBaseUrl": "https://crate.ink",
  "public": true,
  "gameType": "rockpaperscissors",
  "status": "waiting",
  "player1Name": "Alice",
  "player1WalletAddress": "xch1abc123...",
  "player1PeerId": "peer-123",
  "wagerAmount": 1000000
}
```

**Request Example (Create Private Room):**
```json
{
  "roomId": "private-room-456",
  "appBaseUrl": "https://crate.ink",
  "public": false,
  "gameType": "calpoker",
  "status": "waiting",
  "player1Name": "Alice",
  "player1WalletAddress": "xch1abc123...",
  "player1PeerId": "peer-123"
}
```

**Response:**
```json
{
  "tracker id": "abc123...",
  "interval": 60,
  "min interval": 30,
  "complete": 1,
  "incomplete": 0,
  "room": {
    "roomId": "unique-room-id",
    "appBaseUrl": "https://crate.ink",
    "public": true,
    "gameType": "rockpaperscissors",
    "status": "waiting",
    // ... full room object
  }
}
```

**Notes:**
- Same `roomId` updates existing room (idempotent)
- Rooms expire after 10 minutes without updates
- Send periodic updates (every 30-60s) to keep room alive
- Maximum 100 rooms stored (oldest removed if limit exceeded)

### GET /scrape - Tracker Statistics

Get comprehensive tracker statistics including room counts by game type and status.

**Response:**
```json
{
  "tracker id": "abc123...",
  "files": {
    "_total": {
      "complete": 42,
      "incomplete": 0
    },
    "_by_game_type": {
      "rockpaperscissors": 20,
      "calpoker": 15,
      "battleship": 7,
      "tictactoe": 0
    },
    "_by_status": {
      "waiting": 30,
      "active": 12,
      "finished": 0,
      "cancelled": 0
    }
  }
}
```

### GET /health - Health Check

Health check endpoint for monitoring.

```json
{
  "status": "ok",
  "tracker": "abc123...",
  "rooms": 42,
  "timestamp": 1234567890
}
```

## Security Features

### Rate Limiting

- **GET requests**: 120 requests/minute per IP (configurable via `RATE_LIMIT_MAX_REQUESTS`)
- **POST requests**: 20 requests/minute per IP (configurable via `RATE_LIMIT_MAX_ANNOUNCES`)
- **Automatic blocking**: IPs blocked after 10 violations (configurable via `MAX_VIOLATIONS`)
- **Block duration**: 5 minutes (configurable via `BLOCK_DURATION`)
- **Localhost bypass**: Rate limiting disabled for `127.0.0.1` / `localhost` (development)

### IP Blocking

- **Temporary blocks**: 5 minutes for abuse (configurable)
- **Permanent blocklist**: Via `BLOCKED_IPS` set in code
- **Automatic blocking**: After repeated rate limit violations
- **Cleanup**: Expired blocks automatically removed

### Input Validation

- **Room ID**: Alphanumeric, dash, underscore only (max 100 chars)
- **Game type**: Whitelist validation (`rockpaperscissors`, `calpoker`, `battleship`, `tictactoe`, or `null`)
- **Player names**: Max 50 characters, non-empty
- **Wallet addresses**: Chia format validation (must start with `xch1` or `txch1`, max 100 chars)
- **appBaseUrl**: Valid URL format (required)
- **Wager amounts**: Non-negative integer, max 1 trillion mojos
- **Status**: Whitelist validation (`waiting`, `active`, `finished`, `cancelled`)

### Replay Attack Prevention

- **Nonce tracking**: Prevents duplicate announcements (max 5000 nonces tracked)
- **Timestamp validation**: 30-second tolerance
- **Nonce cleanup**: Expired nonces removed after 5 minutes

### Request Limits

- **Max request size**: 10KB (prevents DoS)
- **Server timeout**: 30 seconds (prevents hanging requests)
- **Memory bounds**: Maximum 100 rooms, 1000 rate limit entries (prevents OOM)

## Heroku Deployment

### Quick Deploy

```bash
# Create app
heroku create chia-gaming-tracker

# Set environment variables (optional)
heroku config:set TRACKER_ID=your-tracker-id

# Deploy
git push heroku main

# Scale dyno
heroku ps:scale web=1
```

### Important Notes

1. **Heroku Free Tier Limitations**: 
   - Free tier dynos sleep after 30 minutes of inactivity
   - Free tier has limited monthly hours (550 hours/month)
   - **Memory limit: 512MB** - In-memory storage is efficient
   - Consider upgrading to Eco ($5/month) or Basic ($7/month) for always-on service

2. **Keep Dyno Alive**:
   - Use a service like [Kaffeine](https://kaffeine.herokuapp.com/) to ping your app
   - Or upgrade to a paid dyno tier

3. **Port Configuration**:
   - Heroku automatically sets `PORT` environment variable
   - The server correctly uses `process.env.PORT || 8766`
   - No manual port configuration needed

4. **Health Check**:
   - Endpoint: `https://your-app.herokuapp.com/health`
   - Use this for monitoring and keep-alive pings

## Docker

### Build and Run

```bash
# Build Docker image
docker build -t chia-gaming-tracker .

# Run container
docker run -d \
  -p 8766:8766 \
  -e PORT=8766 \
  -e DISABLE_RATE_LIMIT=false \
  --name tracker \
  chia-gaming-tracker
```

### Docker Compose

For easier setup with environment variables:

```bash
# Start with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

The `docker-compose.yml` includes:
- Pre-configured environment variables
- Health checks
- Automatic restarts
- Network configuration

### Docker Image Features

- Multi-stage build for optimized image size
- Non-root user for security
- Health check endpoint
- Production-ready configuration

## AWS Deployment

### Option 1: AWS ECS (Elastic Container Service)

Deploy using Docker containers on AWS ECS:

**Prerequisites:**
- AWS CLI configured
- Docker image pushed to Amazon ECR (Elastic Container Registry)

**Steps:**

1. **Create ECR Repository:**
```bash
aws ecr create-repository --repository-name chia-gaming-tracker --region us-east-1
```

2. **Login to ECR:**
```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com
```

3. **Build and Push Image:**
```bash
# Build image
docker build -t chia-gaming-tracker .

# Tag for ECR
docker tag chia-gaming-tracker:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/chia-gaming-tracker:latest

# Push to ECR
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/chia-gaming-tracker:latest
```

4. **Create ECS Task Definition:**
Create `task-definition.json`:
```json
{
  "family": "chia-gaming-tracker",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "tracker",
      "image": "<account-id>.dkr.ecr.us-east-1.amazonaws.com/chia-gaming-tracker:latest",
      "portMappings": [
        {
          "containerPort": 8766,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "PORT", "value": "8766"},
        {"name": "DISABLE_RATE_LIMIT", "value": "false"}
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "node -e \"require('http').get('http://localhost:8766/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})\""],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/chia-gaming-tracker",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

5. **Register Task Definition:**
```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

6. **Create ECS Service:**
```bash
aws ecs create-service \
  --cluster your-cluster-name \
  --service-name chia-gaming-tracker \
  --task-definition chia-gaming-tracker \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

**Note:** Replace placeholders with your actual AWS account ID, region, subnet IDs, and security group IDs.

### Option 2: AWS EC2

Deploy directly on an EC2 instance:

1. **Launch EC2 Instance:**
   - Amazon Linux 2023 or Ubuntu
   - t3.micro or larger (512MB+ RAM recommended)
   - Security group: Allow inbound port 8766 (or use ALB on port 80/443)

2. **Connect and Setup:**
```bash
# Update system
sudo yum update -y  # Amazon Linux
# or
sudo apt update && sudo apt upgrade -y  # Ubuntu

# Install Node.js 18+
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Or for Ubuntu:
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Git
sudo yum install -y git  # or sudo apt install git
```

3. **Clone and Deploy:**
```bash
# Clone repository
git clone https://github.com/Koba42Corp/chia-gaming-tracker.git
cd chia-gaming-tracker

# Install dependencies
npm install --production

# Set environment variables
export PORT=8766
export DISABLE_RATE_LIMIT=false
# Add other env vars as needed

# Start with PM2 (process manager)
sudo npm install -g pm2
pm2 start index.js --name tracker
pm2 save
pm2 startup  # Follow instructions to enable auto-start
```

4. **Configure Firewall:**
```bash
# Allow port 8766
sudo firewall-cmd --permanent --add-port=8766/tcp  # CentOS/RHEL
sudo firewall-cmd --reload

# Or for Ubuntu:
sudo ufw allow 8766/tcp
sudo ufw reload
```

5. **Optional: Use Nginx as Reverse Proxy:**
```bash
# Install Nginx
sudo yum install -y nginx  # or sudo apt install nginx

# Configure reverse proxy in /etc/nginx/conf.d/tracker.conf:
# server {
#     listen 80;
#     server_name your-domain.com;
#     
#     location / {
#         proxy_pass http://localhost:8766;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection 'upgrade';
#         proxy_set_header Host $host;
#         proxy_cache_bypass $http_upgrade;
#     }
# }

sudo systemctl start nginx
sudo systemctl enable nginx
```

### Option 3: AWS Elastic Beanstalk

Simple PaaS deployment:

1. **Install EB CLI:**
```bash
pip install awsebcli
```

2. **Initialize:**
```bash
eb init -p "Node.js 18 running on 64bit Amazon Linux 2023" chia-gaming-tracker
```

3. **Create Environment:**
```bash
eb create tracker-env
```

4. **Set Environment Variables:**
```bash
eb setenv PORT=8766 DISABLE_RATE_LIMIT=false
```

5. **Deploy:**
```bash
eb deploy
```

**AWS Considerations:**
- **Load Balancing**: Use Application Load Balancer (ALB) for high availability
- **Auto Scaling**: Configure auto-scaling groups for EC2/ECS
- **Monitoring**: Use CloudWatch for logs and metrics
- **Health Checks**: Configure health checks pointing to `/health` endpoint
- **Security**: Use security groups and IAM roles appropriately
- **HTTPS**: Use ALB with ACM certificate or CloudFront for SSL/TLS

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run locally
npm start

# Or with auto-reload
npm run dev
```

The server will:
- Run on `http://localhost:8766`
- Accept local client requests
- Rate limiting can be disabled in development via `DISABLE_RATE_LIMIT=true`

### Testing

**Automated Tests:**

The project includes comprehensive integration tests using Jest and Supertest:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

Tests cover:
- Health check endpoint
- Room creation and validation
- Room updates
- Room listing with filters
- Private/public room visibility
- Search functionality
- Pagination and sorting
- Statistics endpoint
- Error handling

**Manual Testing:**

```bash
# Health check
curl http://localhost:8766/health

# List rooms
curl http://localhost:8766/announce

# Announce a room
curl -X POST http://localhost:8766/announce \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "test-room-123",
    "appBaseUrl": "https://crate.ink",
    "gameType": "rockpaperscissors",
    "status": "waiting",
    "player1Name": "TestPlayer",
    "player1WalletAddress": "xch1test1234567890123456789012345678901234567890",
    "player1PeerId": "peer-test-123"
  }'
```

## Protocol Details

### Response Format

All responses follow a standard format:

- `tracker id` - Unique tracker identifier
- `interval` - Recommended announce interval (seconds)
- `min interval` - Minimum allowed interval (seconds)
- `complete` - Total matching rooms
- `incomplete` - Not used (always 0)
- `failure reason` - Error message (on errors)

### Room Data Structure

```typescript
interface RoomRecord {
  roomId: string;              // Unique identifier
  gameType: string;            // Game type
  status: 'waiting' | 'active' | 'finished' | 'cancelled';
  public: boolean;             // Visibility (false = private)
  appBaseUrl: string;          // Base URL for joining
  player1Name: string;
  player1WalletAddress: string;
  player1PeerId: string;
  player2Name: string | null;
  player2WalletAddress: string | null;
  player2PeerId: string | null;
  wagerAmount: number;
  createdAt: number;
  updatedAt: number;
}
```

### Room Expiration

- Rooms expire after 10 minutes of inactivity (configurable via `PEER_TIMEOUT`)
- Expired rooms are automatically cleaned up every minute
- Rooms are refreshed when re-announced (send periodic updates to keep alive)

## Production Considerations

### Performance

- **In-memory storage**: Fast lookups, no database overhead
- **Automatic cleanup**: Expired rooms removed every minute
- **Efficient filtering**: All filters applied in-memory
- **Pagination**: Supports large result sets

### Scalability

- **In-memory storage**: Fast, efficient lookups
- **Memory efficient**: Only active rooms stored (max 100 rooms)
- **Automatic cleanup**: Expired rooms removed automatically
- **Stateless design**: Simple, reliable operation

### Monitoring

- **Health endpoint**: `/health` for uptime monitoring
- **Statistics endpoint**: `/scrape` for metrics
- **Console logging**: All operations logged
- **Error tracking**: Comprehensive error handling

## License

Open Source

## Credits

Built by [@DracattusDev](https://koba42.com) and [@MrDennisV](https://github.com/MrDennisV) for decentralized, interoperable game room discovery and management.
