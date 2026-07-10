const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CaribWayz API',
      version: '1.0.0',
      description: 'CaribWayz Navigation App — REST API for mobile and web clients',
      contact: { name: 'CaribWayz Team' },
    },
    servers: [
      { url: 'https://caribwayz-api-new.onrender.com/api/v1', description: 'Production' },
      { url: 'http://localhost:5000/api/v1', description: 'Local Development' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter JWT token from /auth/login or /auth/register',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Error description' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'John Doe' },
            email: { type: 'string', example: 'john@example.com' },
            phone: { type: 'string', example: '+18681234567', nullable: true },
            profile_image: { type: 'string', nullable: true },
            role: { type: 'string', enum: ['user', 'admin'] },
            status: { type: 'string', enum: ['active', 'suspended'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Route: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            route_name: { type: 'string', example: 'Home to Work' },
            start_lat: { type: 'number', example: 10.6918 },
            start_lng: { type: 'number', example: -61.2225 },
            end_lat: { type: 'number', example: 10.5267 },
            end_lng: { type: 'number', example: -61.3973 },
            distance_km: { type: 'number', example: 25.4 },
            estimated_minutes: { type: 'integer', example: 35 },
            polyline: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['planned', 'in-progress', 'completed', 'cancelled'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Report: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: ['police', 'construction', 'hazard', 'traffic', 'other'] },
            latitude: { type: 'number', example: 10.6918 },
            longitude: { type: 'number', example: -61.2225 },
            description: { type: 'string', example: 'Speed trap on highway' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            confirmed_count: { type: 'integer', example: 3 },
            status: { type: 'string', enum: ['active', 'expired', 'removed'] },
            expires_at: { type: 'string', format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Group: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Family Trip' },
            join_code: { type: 'string', example: 'ABC123' },
            destination_lat: { type: 'number', nullable: true },
            destination_lng: { type: 'number', nullable: true },
            destination_address: { type: 'string', nullable: true },
            created_by: { type: 'string', format: 'uuid' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Notification: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            body: { type: 'string' },
            type: { type: 'string' },
            is_read: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    tags: [
      { name: 'Health', description: 'API status' },
      { name: 'Auth', description: 'Register, login, password reset' },
      { name: 'User', description: 'Profile and preferences' },
      { name: 'Routes', description: 'Navigation route planning' },
      { name: 'Groups', description: 'Shared navigation groups with live locations' },
      { name: 'Reports', description: 'Community safety reports' },
      { name: 'POIs', description: 'Points of interest' },
      { name: 'Emergency', description: 'Emergency alerts with FCM broadcast' },
      { name: 'Notifications', description: 'In-app notifications' },
      { name: 'Admin', description: 'Admin-only management endpoints' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          description: 'Check if the API is online. No authentication required.',
          responses: {
            200: {
              description: 'API is running',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      message: { type: 'string', example: 'CaribWayz API is running' },
                      version: { type: 'string', example: '1.0.0' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ── AUTH ─────────────────────────────────────────────────────────────
      '/auth/register': {
        post: {
          tags: ['Auth'],
          summary: 'Register a new user',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'email', 'phone', 'emergency_contact', 'user_type', 'password'],
                  properties: {
                    name: { type: 'string', example: 'John Doe' },
                    email: { type: 'string', example: 'john@example.com' },
                    phone: { type: 'string', example: '+18681234567' },
                    emergency_contact: { type: 'string', example: '+18687654321', description: 'Emergency contact phone number' },
                    user_type: { type: 'string', enum: ['CaribDrivers', 'CaribOfficials'], example: 'CaribDrivers' },
                    password: { type: 'string', example: 'Password@1', description: 'Min 6 chars, 1 uppercase, 1 number, 1 special symbol' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'User registered successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          token: { type: 'string', example: 'eyJhbGci...' },
                          user: { $ref: '#/components/schemas/User' },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            409: { description: 'Email already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', example: 'admin@caribwayz.com' },
                    password: { type: 'string', example: 'Admin@1234' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Login successful — returns JWT token',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          token: { type: 'string', example: 'eyJhbGci...' },
                          user: { $ref: '#/components/schemas/User' },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/auth/forgot-password': {
        post: {
          tags: ['Auth'],
          summary: 'Request password reset OTP',
          description: 'Generates a 6-digit OTP valid for 15 minutes. OTP is returned in the response until SMS/email service is integrated.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: { email: { type: 'string', example: 'john@example.com' } },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'OTP generated',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          otp: { type: 'string', example: '482910', description: 'Use this OTP in /auth/otp-verify' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/auth/otp-verify': {
        post: {
          tags: ['Auth'],
          summary: 'Verify OTP and reset password',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'otp', 'new_password'],
                  properties: {
                    email: { type: 'string', example: 'john@example.com' },
                    otp: { type: 'string', example: '123456' },
                    new_password: { type: 'string', example: 'NewPassword123' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Password reset successfully' },
            400: { description: 'Invalid or expired OTP', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['Auth'],
          summary: 'Logout (client deletes token)',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Logged out' },
            401: { description: 'Unauthorized' },
          },
        },
      },

      // ── USER ─────────────────────────────────────────────────────────────
      '/user/profile': {
        get: {
          tags: ['User'],
          summary: 'Get my profile',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'User profile including user_type and emergency_contact',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          name: { type: 'string' },
                          email: { type: 'string' },
                          phone: { type: 'string', nullable: true },
                          emergency_contact: { type: 'string', nullable: true },
                          user_type: { type: 'string', enum: ['CaribDrivers', 'CaribOfficials'] },
                          profile_image: { type: 'string', nullable: true },
                          role: { type: 'string' },
                          status: { type: 'string' },
                          created_at: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { description: 'Unauthorized' },
          },
        },
        put: {
          tags: ['User'],
          summary: 'Update profile — name, phone, emergency_contact, password, profile image',
          description: 'Send as `multipart/form-data` when uploading a profile image, otherwise `application/json`. For password change, include both `current_password` and `new_password`.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', example: 'John Updated' },
                    phone: { type: 'string', example: '+18681234567' },
                    emergency_contact: { type: 'string', example: '+18687654321' },
                    current_password: { type: 'string', description: 'Required only when changing password' },
                    new_password: { type: 'string', description: 'Min 6 chars, 1 uppercase, 1 number, 1 special symbol' },
                    profile_image: { type: 'string', format: 'binary', description: 'Image file (max 5 MB). Uploaded to Firebase Storage.' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Updated profile' },
            400: { description: 'Wrong current_password or validation error' },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/user/preferences': {
        get: {
          tags: ['User'],
          summary: 'Get notification preferences',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Preferences',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          alert_police: { type: 'boolean' },
                          alert_construction: { type: 'boolean' },
                          alert_hazards: { type: 'boolean' },
                          alert_traffic: { type: 'boolean' },
                          alert_business: { type: 'boolean' },
                          alert_tourism: { type: 'boolean' },
                          priority_level: { type: 'string', enum: ['low', 'medium', 'high'] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        put: {
          tags: ['User'],
          summary: 'Update notification preferences',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    alert_police: { type: 'boolean' },
                    alert_construction: { type: 'boolean' },
                    alert_hazards: { type: 'boolean' },
                    alert_traffic: { type: 'boolean' },
                    alert_business: { type: 'boolean' },
                    alert_tourism: { type: 'boolean' },
                    priority_level: { type: 'string', enum: ['low', 'medium', 'high'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated preferences' } },
        },
      },

      // ── ROUTES ───────────────────────────────────────────────────────────
      '/routes/create': {
        post: {
          tags: ['Routes'],
          summary: 'Create a navigation route',
          description: 'Calculates distance and ETA using Google Directions API (falls back to Haversine formula).',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['start_lat', 'start_lng', 'end_lat', 'end_lng'],
                  properties: {
                    start_lat: { type: 'number', example: 10.6918 },
                    start_lng: { type: 'number', example: -61.2225 },
                    end_lat: { type: 'number', example: 10.5267 },
                    end_lng: { type: 'number', example: -61.3973 },
                    route_name: { type: 'string', example: 'Home to Work' },
                    stops: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          lat: { type: 'number' },
                          lng: { type: 'number' },
                          address: { type: 'string' },
                          sequence: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Route created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Route' } } } } } },
            400: { description: 'Validation error' },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/routes': {
        get: {
          tags: ['Routes'],
          summary: 'Get my routes',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'List of routes', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Route' } } } } } } },
          },
        },
      },
      '/routes/{id}': {
        get: {
          tags: ['Routes'],
          summary: 'Get route by ID (with stops)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Route with stops' },
            404: { description: 'Not found' },
          },
        },
        put: {
          tags: ['Routes'],
          summary: 'Update route name or status',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    route_name: { type: 'string' },
                    status: { type: 'string', enum: ['planned', 'in-progress', 'completed', 'cancelled'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated route' } },
        },
      },
      '/routes/{id}/start': {
        post: {
          tags: ['Routes'],
          summary: 'Start navigation (planned → in-progress)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Navigation started' }, 400: { description: 'Route not in planned state' } },
        },
      },
      '/routes/{id}/complete': {
        post: {
          tags: ['Routes'],
          summary: 'Complete navigation (in-progress → completed)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Navigation completed' }, 400: { description: 'Route not in-progress' } },
        },
      },

      // ── GROUPS ───────────────────────────────────────────────────────────
      '/groups': {
        post: {
          tags: ['Groups'],
          summary: 'Create a group',
          description: 'Creates a group with a unique 6-char join code. Creator is auto-added as a member.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', example: 'Family Trip' },
                    destination_lat: { type: 'number', example: 10.5267 },
                    destination_lng: { type: 'number', example: -61.3973 },
                    destination_address: { type: 'string', example: 'Maracas Beach' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Group created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Group' } } } } } },
          },
        },
      },
      '/groups/join': {
        post: {
          tags: ['Groups'],
          summary: 'Join a group by join code',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['join_code'],
                  properties: {
                    join_code: { type: 'string', example: 'ABC123' },
                    current_latitude: { type: 'number', example: 10.6918, description: 'Joiner current latitude' },
                    current_longitude: { type: 'number', example: -61.2225, description: 'Joiner current longitude' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Joined group', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Group' } } } } } },
            404: { description: 'Invalid join code' },
          },
        },
      },
      '/groups/{id}': {
        get: {
          tags: ['Groups'],
          summary: 'Get group details and active members',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: {
              description: 'Group with members',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          group: { $ref: '#/components/schemas/Group' },
                          members: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, user_id: { type: 'string' }, name: { type: 'string' }, profile_image: { type: 'string', nullable: true }, status: { type: 'string' }, joined_at: { type: 'string' } } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/groups/{id}/leave': {
        post: {
          tags: ['Groups'],
          summary: 'Leave a group',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Left group successfully' } },
        },
      },
      '/groups/{id}/location': {
        post: {
          tags: ['Groups'],
          summary: 'Update my live location in the group',
          description: 'Pushes location to Firebase Realtime DB at `groups/{groupId}/members/{userId}`. Subscribe to this path in the mobile app for real-time tracking.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['latitude', 'longitude'],
                  properties: {
                    latitude: { type: 'number', example: 10.6918 },
                    longitude: { type: 'number', example: -61.2225 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Location updated in Firebase' }, 403: { description: 'Not a group member' } },
        },
      },

      // ── REPORTS ──────────────────────────────────────────────────────────
      '/reports': {
        post: {
          tags: ['Reports'],
          summary: 'Submit a community report',
          description: 'Reports auto-expire after 4 hours.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['type', 'latitude', 'longitude'],
                  properties: {
                    type: { type: 'string', enum: ['police', 'construction', 'hazard', 'traffic', 'other'], example: 'police' },
                    latitude: { type: 'number', example: 10.6918 },
                    longitude: { type: 'number', example: -61.2225 },
                    description: { type: 'string', example: 'Speed trap on highway' },
                    severity: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Report submitted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Report' } } } } } },
          },
        },
      },
      '/reports/nearby': {
        get: {
          tags: ['Reports'],
          summary: 'Get nearby active reports',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'lat', in: 'query', required: true, schema: { type: 'number' }, example: 10.6918 },
            { name: 'lng', in: 'query', required: true, schema: { type: 'number' }, example: -61.2225 },
            { name: 'radius', in: 'query', schema: { type: 'number', default: 5 }, description: 'Search radius in km' },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['police', 'construction', 'hazard', 'traffic', 'other'] }, description: 'Filter by type' },
          ],
          responses: {
            200: { description: 'Nearby reports with distance_km', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Report' } } } } } } },
          },
        },
      },
      '/reports/{id}/confirm': {
        post: {
          tags: ['Reports'],
          summary: 'Confirm a report (upvote)',
          description: 'Each user can confirm a report once. Increments confirmed_count.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Confirmed — returns updated confirmed_count' },
            409: { description: 'Already confirmed' },
          },
        },
      },

      // ── POIS ─────────────────────────────────────────────────────────────
      '/pois': {
        get: {
          tags: ['POIs'],
          summary: 'Get nearby points of interest',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'lat', in: 'query', required: true, schema: { type: 'number' }, example: 10.6918 },
            { name: 'lng', in: 'query', required: true, schema: { type: 'number' }, example: -61.2225 },
            { name: 'radius', in: 'query', schema: { type: 'number', default: 10 }, description: 'Radius in km' },
            { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter by category' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          ],
          responses: {
            200: {
              description: 'POIs sorted by proximity',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            category: { type: 'string' },
                            latitude: { type: 'number' },
                            longitude: { type: 'number' },
                            address: { type: 'string' },
                            phone: { type: 'string', nullable: true },
                            website: { type: 'string', nullable: true },
                            description: { type: 'string', nullable: true },
                            distance_km: { type: 'number' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ── EMERGENCY ────────────────────────────────────────────────────────
      '/emergency': {
        post: {
          tags: ['Emergency'],
          summary: 'Trigger an emergency alert',
          description: 'Creates an emergency record and sends FCM push notification to all users subscribed to the `emergency_alerts` topic.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['type', 'latitude', 'longitude'],
                  properties: {
                    type: { type: 'string', enum: ['accident', 'medical', 'security', 'natural_disaster', 'other'], example: 'accident' },
                    latitude: { type: 'number', example: 10.6918 },
                    longitude: { type: 'number', example: -61.2225 },
                    description: { type: 'string', example: 'Multi-vehicle accident, road blocked' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Emergency alert triggered and broadcast via FCM' },
          },
        },
      },
      '/emergency/{id}': {
        get: {
          tags: ['Emergency'],
          summary: 'Get emergency alert status',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Emergency alert record' } },
        },
      },
      '/emergency/{id}/resolve': {
        post: {
          tags: ['Emergency'],
          summary: 'Resolve an emergency alert',
          description: 'Only the original reporter or an admin can resolve.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Alert resolved' }, 403: { description: 'Not authorized to resolve' } },
        },
      },

      // ── NOTIFICATIONS ────────────────────────────────────────────────────
      '/notifications': {
        get: {
          tags: ['Notifications'],
          summary: 'Get my notifications',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 30 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'unread_only', in: 'query', schema: { type: 'boolean' }, description: 'Set true to return only unread' },
          ],
          responses: {
            200: {
              description: 'Notifications list with unread count',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          notifications: { type: 'array', items: { $ref: '#/components/schemas/Notification' } },
                          unread_count: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/notifications/read': {
        post: {
          tags: ['Notifications'],
          summary: 'Mark notifications as read',
          description: 'Pass an empty array `[]` for `notification_ids` to mark all as read.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    notification_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, example: [] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Marked as read' } },
        },
      },

      // ── ADMIN ─────────────────────────────────────────────────────────────
      '/admin/dashboard': {
        get: {
          tags: ['Admin'],
          summary: 'Dashboard statistics',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'App-wide stats',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          total_users: { type: 'integer' },
                          total_routes: { type: 'integer' },
                          active_reports: { type: 'integer' },
                          active_emergencies: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
            403: { description: 'Admin role required' },
          },
        },
      },
      '/admin/users': {
        get: {
          tags: ['Admin'],
          summary: 'List all users',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'suspended'] } },
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search by name or email' },
          ],
          responses: { 200: { description: 'Users list with total count' } },
        },
      },
      '/admin/users/{id}/status': {
        patch: {
          tags: ['Admin'],
          summary: 'Update user status (suspend/activate)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: { status: { type: 'string', enum: ['active', 'suspended'] } },
                },
              },
            },
          },
          responses: { 200: { description: 'Status updated' } },
        },
      },
      '/admin/routes': {
        get: {
          tags: ['Admin'],
          summary: 'List all routes (with user info)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['planned', 'in-progress', 'completed', 'cancelled'] } },
          ],
          responses: { 200: { description: 'All routes with user_name and user_email' } },
        },
      },
      '/admin/reports': {
        get: {
          tags: ['Admin'],
          summary: 'List all reports',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'All reports with reporter_name' } },
        },
      },
      '/admin/reports/{id}': {
        delete: {
          tags: ['Admin'],
          summary: 'Remove a report (soft delete)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Report removed (status set to removed)' } },
        },
      },
      '/admin/businesses': {
        post: {
          tags: ['Admin'],
          summary: 'Add a business / POI',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'latitude', 'longitude'],
                  properties: {
                    name: { type: 'string', example: 'KFC Port of Spain' },
                    latitude: { type: 'number', example: 10.6525 },
                    longitude: { type: 'number', example: -61.5090 },
                    category: { type: 'string', example: 'restaurant' },
                    address: { type: 'string', example: 'Independence Square, POS' },
                    phone: { type: 'string', example: '+18681234567' },
                    website: { type: 'string', example: 'https://kfc.com' },
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Business added' } },
        },
        get: {
          tags: ['Admin'],
          summary: 'Get all businesses',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'All businesses' } },
        },
      },
    },
  },
  apis: [],
};

module.exports = swaggerJsdoc(options);
