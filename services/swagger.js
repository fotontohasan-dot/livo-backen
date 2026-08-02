// services/swagger.js
// OpenAPI 3.0 specification + swagger-ui-express setup

const swaggerJsdoc = require('swagger-jsdoc');

const BASE_URL = process.env.BASE_URL || 'https://livo-backen.onrender.com';

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'Livo API',
    version: '1.0.0',
    description: `
## Livo Platform REST API — v1

সব endpoint \`/api/v1\` prefix-এর অধীনে পাওয়া যাবে।

### Authentication
- **Session Cookie** — browser-based login (POST /api/v1/auth/login)
- **API Key** — \`X-API-Key\` header (admin-generated keys)

### Response Format
\`\`\`json
{ "success": true, "data": {...} }
{ "success": false, "error": "error message" }
\`\`\`

### Rate Limits
| Scope | Limit |
|-------|-------|
| General | 100 req/min |
| Login/Register | 10 req/min |
| Financial | 20 req/min |
| API | 60 req/min |
    `.trim(),
    contact: { name: 'Livo Support', url: BASE_URL },
    license: { name: 'Private' }
  },
  servers: [
    { url: BASE_URL + '/api/v1', description: 'Production' },
    { url: 'http://localhost:3000/api/v1', description: 'Local Dev' }
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey', in: 'cookie', name: 'connect.sid',
        description: 'Session cookie — POST /auth/login দিয়ে পাওয়া যাবে'
      },
      apiKey: {
        type: 'apiKey', in: 'header', name: 'X-API-Key',
        description: 'Admin panel থেকে জেনারেট করা API Key'
      }
    },
    schemas: {
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true }
        }
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error:   { type: 'string',  example: 'Unauthorized' }
        }
      },
      User: {
        type: 'object',
        properties: {
          id:       { type: 'integer', example: 42 },
          username: { type: 'string',  example: 'john_doe' },
          email:    { type: 'string',  example: 'john@example.com' },
          phone:    { type: 'string',  example: '+8801700000000' },
          balance:  { type: 'number',  example: 1500.50 },
          role:     { type: 'string',  example: 'user', enum: ['user', 'admin'] },
          status:   { type: 'string',  example: 'active' },
          created_at: { type: 'string', format: 'date-time' }
        }
      },
      Match: {
        type: 'object',
        properties: {
          id:          { type: 'integer', example: 1 },
          home_team:   { type: 'string',  example: 'Barcelona' },
          away_team:   { type: 'string',  example: 'Real Madrid' },
          sport:       { type: 'string',  example: 'football' },
          league:      { type: 'string',  example: 'La Liga' },
          start_time:  { type: 'string',  format: 'date-time' },
          status:      { type: 'string',  example: 'upcoming', enum: ['upcoming','live','ended'] },
          home_odds:   { type: 'number',  example: 1.85 },
          draw_odds:   { type: 'number',  example: 3.40 },
          away_odds:   { type: 'number',  example: 4.20 }
        }
      },
      Game: {
        type: 'object',
        properties: {
          id:        { type: 'integer', example: 10 },
          name:      { type: 'string',  example: 'Aviator' },
          slug:      { type: 'string',  example: 'aviator' },
          emoji:     { type: 'string',  example: '✈️' },
          category:  { type: 'string',  example: 'slots' },
          provider:  { type: 'string',  example: 'Spribe' },
          badge:     { type: 'string',  example: 'hot', nullable: true },
          is_active: { type: 'boolean', example: true }
        }
      },
      PaymentRequest: {
        type: 'object',
        properties: {
          id:         { type: 'integer', example: 55 },
          type:       { type: 'string',  example: 'deposit', enum: ['deposit','withdraw'] },
          amount:     { type: 'number',  example: 500.00 },
          status:     { type: 'string',  example: 'pending', enum: ['pending','approved','rejected'] },
          method:     { type: 'string',  example: 'bkash' },
          created_at: { type: 'string',  format: 'date-time' }
        }
      },
      Bet: {
        type: 'object',
        properties: {
          id:        { type: 'integer', example: 201 },
          match_id:  { type: 'integer', example: 1 },
          stake:     { type: 'number',  example: 100.00 },
          odd:       { type: 'number',  example: 1.85 },
          selection: { type: 'string',  example: 'home' },
          status:    { type: 'string',  example: 'pending', enum: ['pending','won','lost','refunded'] },
          potential_win: { type: 'number', example: 185.00 },
          created_at: { type: 'string', format: 'date-time' }
        }
      },
      PaginatedResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          page:    { type: 'integer', example: 1 },
          total:   { type: 'integer', example: 150 },
          data:    { type: 'array', items: {} }
        }
      }
    },
    responses: {
      Unauthorized: {
        description: 'Authentication required',
        content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' }, example: { success: false, error: 'Unauthorized' } } }
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' }, example: { success: false, error: 'Not found' } } }
      },
      RateLimit: {
        description: 'Too many requests',
        content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' }, example: { success: false, error: 'Rate limit exceeded' } } }
      },
      ServerError: {
        description: 'Internal server error',
        content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } }
      }
    }
  },
  security: [{ cookieAuth: [] }],
  tags: [
    { name: 'Auth',          description: 'Registration, Login, Password reset' },
    { name: 'Matches',       description: 'Sports matches, betting' },
    { name: 'Games',         description: 'Casino games' },
    { name: 'Payment',       description: 'Deposit & Withdrawal' },
    { name: 'Profile',       description: 'User profile & settings' },
    { name: 'Leaderboard',   description: 'Rankings' },
    { name: 'Coins',         description: 'Demo coins / bonus' },
    { name: 'Notifications', description: 'User notifications' },
    { name: 'Accumulator',   description: 'Parlay/Acca bets' },
    { name: 'Sports',        description: 'Live sports data' },
    { name: 'System',        description: 'Health & version' }
  ],
  paths: {

    // ═══════════════════ SYSTEM ═══════════════════
    '/': {
      get: {
        tags: ['System'], summary: 'API version info',
        responses: {
          200: { description: 'Version and endpoint list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, version: { type: 'string', example: 'v1' }, endpoints: { type: 'object' }, docs: { type: 'string' } } } } } }
        }
      }
    },

    // ═══════════════════ AUTH ═══════════════════
    '/auth/register': {
      post: {
        tags: ['Auth'], summary: 'Register a new user', security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['username','password'], properties: {
            username: { type: 'string', example: 'john_doe', minLength: 3, maxLength: 30 },
            email:    { type: 'string', format: 'email', example: 'john@example.com' },
            phone:    { type: 'string', example: '+8801700000000' },
            password: { type: 'string', format: 'password', example: 'Str0ngPass!', minLength: 6 },
            referral_code: { type: 'string', example: 'REF123' }
          } } } }
        },
        responses: {
          200: { description: 'Registered successfully', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Success' } } } },
          400: { description: 'Validation error', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          429: { '$ref': '#/components/responses/RateLimit' }
        }
      }
    },
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Login', security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['username','password'], properties: {
            username: { type: 'string', example: 'john_doe' },
            password: { type: 'string', format: 'password', example: 'Str0ngPass!' }
          } } } }
        },
        responses: {
          200: { description: 'Login successful — session cookie set', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, user: { '$ref': '#/components/schemas/User' } } } } } },
          400: { description: 'Invalid credentials', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          429: { '$ref': '#/components/responses/RateLimit' }
        }
      }
    },
    '/auth/logout': {
      get: {
        tags: ['Auth'], summary: 'Logout — clears session',
        responses: { 302: { description: 'Redirects to /' } }
      }
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'], summary: 'Request password reset email', security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } }
        },
        responses: {
          200: { description: 'Reset email sent', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Success' } } } },
          404: { '$ref': '#/components/responses/NotFound' }
        }
      }
    },

    // ═══════════════════ MATCHES ═══════════════════
    '/matches': {
      get: {
        tags: ['Matches'], summary: 'List all active matches',
        parameters: [
          { name: 'sport', in: 'query', schema: { type: 'string', example: 'football' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['upcoming','live','ended'] } }
        ],
        responses: {
          200: { description: 'Match list', content: { 'application/json': { schema: { type: 'array', items: { '$ref': '#/components/schemas/Match' } } } } }
        }
      }
    },
    '/matches/api/live': {
      get: {
        tags: ['Matches'], summary: 'Live matches JSON (polling)', security: [],
        responses: {
          200: { description: 'Live match data', content: { 'application/json': { schema: { type: 'array', items: { '$ref': '#/components/schemas/Match' } } } } }
        }
      }
    },
    '/matches/{id}': {
      get: {
        tags: ['Matches'], summary: 'Single match details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: { description: 'Match detail', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Match' } } } },
          404: { '$ref': '#/components/responses/NotFound' }
        }
      }
    },
    '/matches/{id}/bet': {
      post: {
        tags: ['Matches'], summary: 'Place a bet on a match',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['stake','selection'], properties: {
            stake:     { type: 'number', example: 100 },
            selection: { type: 'string', example: 'home', enum: ['home','draw','away'] }
          } } } }
        },
        responses: {
          200: { description: 'Bet placed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, bet: { '$ref': '#/components/schemas/Bet' } } } } } },
          400: { description: 'Insufficient balance or invalid bet', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },

    // ═══════════════════ GAMES ═══════════════════
    '/games/play': {
      get: {
        tags: ['Games'], summary: 'Games lobby list',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string', example: 'slots' } },
          { name: 'provider', in: 'query', schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Game list', content: { 'application/json': { schema: { type: 'array', items: { '$ref': '#/components/schemas/Game' } } } } }
        }
      }
    },
    '/games/{slug}': {
      get: {
        tags: ['Games'], summary: 'Single game info by slug',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string', example: 'aviator' } }],
        responses: {
          200: { description: 'Game detail', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Game' } } } },
          404: { '$ref': '#/components/responses/NotFound' }
        }
      }
    },

    // ═══════════════════ PAYMENT ═══════════════════
    '/payment/deposit': {
      get: {
        tags: ['Payment'], summary: 'Deposit page / available methods',
        responses: {
          200: { description: 'Deposit methods', content: { 'application/json': { schema: { type: 'object' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      },
      post: {
        tags: ['Payment'], summary: 'Submit a deposit request',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['amount','method'], properties: {
            amount:         { type: 'number', minimum: 100, example: 500 },
            method:         { type: 'string', example: 'bkash', enum: ['bkash','nagad','rocket','bank'] },
            account_number: { type: 'string', example: '01700000000' },
            transaction_id: { type: 'string', example: 'TXN123456' }
          } } } }
        },
        responses: {
          200: { description: 'Deposit submitted', content: { 'application/json': { schema: { '$ref': '#/components/schemas/PaymentRequest' } } } },
          400: { description: 'Validation error', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/payment/withdraw': {
      post: {
        tags: ['Payment'], summary: 'Submit a withdrawal request',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['amount','method','account_number'], properties: {
            amount:         { type: 'number', minimum: 200, example: 300 },
            method:         { type: 'string', example: 'bkash' },
            account_number: { type: 'string', example: '01700000000' },
            withdraw_pin:   { type: 'string', example: '1234' }
          } } } }
        },
        responses: {
          200: { description: 'Withdrawal submitted', content: { 'application/json': { schema: { '$ref': '#/components/schemas/PaymentRequest' } } } },
          400: { description: 'Insufficient balance or invalid PIN', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/payment/history': {
      get: {
        tags: ['Payment'], summary: 'Payment history',
        parameters: [
          { name: 'type',   in: 'query', schema: { type: 'string', enum: ['deposit','withdraw','all'] } },
          { name: 'page',   in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending','approved','rejected'] } }
        ],
        responses: {
          200: { description: 'Payment list', content: { 'application/json': { schema: { '$ref': '#/components/schemas/PaginatedResponse' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },

    // ═══════════════════ PROFILE ═══════════════════
    '/profile': {
      get: {
        tags: ['Profile'], summary: 'Current user profile',
        responses: {
          200: { description: 'Profile data', content: { 'application/json': { schema: { '$ref': '#/components/schemas/User' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/profile/api/balance': {
      get: {
        tags: ['Profile'], summary: 'Real-time balance (polling)',
        responses: {
          200: { description: 'Balance', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, balance: { type: 'number', example: 1500.50 } } } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/profile/update': {
      post: {
        tags: ['Profile'], summary: 'Update profile info',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: {
            email:    { type: 'string', format: 'email' },
            phone:    { type: 'string' },
            full_name:{ type: 'string' }
          } } } }
        },
        responses: {
          200: { description: 'Updated', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Success' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/profile/change-password': {
      post: {
        tags: ['Profile'], summary: 'Change password',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['current_password','new_password'], properties: {
            current_password: { type: 'string', format: 'password' },
            new_password:     { type: 'string', format: 'password', minLength: 6 }
          } } } }
        },
        responses: {
          200: { description: 'Password changed', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Success' } } } },
          400: { description: 'Wrong current password', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/profile/history': {
      get: {
        tags: ['Profile'], summary: 'Bet history',
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }],
        responses: {
          200: { description: 'Bet history', content: { 'application/json': { schema: { '$ref': '#/components/schemas/PaginatedResponse' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },

    // ═══════════════════ LEADERBOARD ═══════════════════
    '/leaderboard': {
      get: {
        tags: ['Leaderboard'], summary: 'Top players ranking',
        parameters: [{ name: 'period', in: 'query', schema: { type: 'string', enum: ['daily','weekly','monthly','all'], default: 'weekly' } }],
        responses: {
          200: { description: 'Leaderboard', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { rank: { type: 'integer' }, username: { type: 'string' }, score: { type: 'number' } } } } } } }
        }
      }
    },

    // ═══════════════════ COINS ═══════════════════
    '/coins/balance': {
      get: {
        tags: ['Coins'], summary: 'Demo coin balance',
        responses: {
          200: { description: 'Coin balance', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, coins: { type: 'integer', example: 9999 } } } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/coins/daily-bonus': {
      post: {
        tags: ['Coins'], summary: 'Claim daily bonus coins',
        responses: {
          200: { description: 'Bonus claimed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, coins_awarded: { type: 'integer' }, new_balance: { type: 'integer' } } } } } },
          400: { description: 'Already claimed today', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },

    // ═══════════════════ NOTIFICATIONS ═══════════════════
    '/notifications': {
      get: {
        tags: ['Notifications'], summary: 'User notifications',
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }],
        responses: {
          200: { description: 'Notifications list', content: { 'application/json': { schema: { '$ref': '#/components/schemas/PaginatedResponse' } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },
    '/notifications/count': {
      get: {
        tags: ['Notifications'], summary: 'Unread notification count',
        responses: {
          200: { description: 'Count', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, count: { type: 'integer', example: 3 } } } } } },
          401: { '$ref': '#/components/responses/Unauthorized' }
        }
      }
    },

    // ═══════════════════ ACCUMULATOR ═══════════════════
    '/accumulator': {
      get: {
        tags: ['Accumulator'], summary: 'Parlay/Accumulator bet builder',
        responses: {
          200: { description: 'Accumulator page or data', content: { 'application/json': { schema: { type: 'object' } } } }
        }
      }
    },

    // ═══════════════════ SPORTS ═══════════════════
    '/sports': {
      get: {
        tags: ['Sports'], summary: 'Live sports data',
        responses: {
          200: { description: 'Sports data', content: { 'application/json': { schema: { type: 'object' } } } }
        }
      }
    }
  }
};

const swaggerSpec = swaggerJsdoc({
  definition,
  apis: [] // all docs are inline above — no file scanning needed
});

module.exports = { swaggerSpec };
