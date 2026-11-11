const swaggerJsdoc = require('swagger-jsdoc');

const errorBody = (example) => ({
  'application/json': {
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string', example },
      },
    },
  },
});

const codedErrorBody = (example, code) => ({
  'application/json': {
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string', example },
        data: { type: 'object', properties: { code: { type: 'string', example: code } } },
      },
    },
  },
});

/** The three Firebase sign-in routes share one contract. */
const firebaseSignInDoc = (label, signInProvider) => ({
  tags: ['Auth'],
  summary: `Sign in with ${label} through Firebase`,
  description:
    `Send the Firebase ID token the app got after signing in with ${label}. The server verifies it and requires ` +
    `firebase.sign_in_provider to be "${signInProvider}". Email, name and photo come from the verified token, never ` +
    'from the body. A returning user is found by Firebase uid. A sign-in is never attached to an existing account ' +
    'by email: an email that is already registered is a 409 EMAIL_IN_USE. A new account is created on first sign-in. Rate limited to 30 requests per IP per ' +
    '15 minutes across the three sign-in routes.',
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['idToken'],
          properties: {
            idToken: { type: 'string', description: 'Firebase ID token (FirebaseUser.getIdToken())' },
            name: {
              type: 'string',
              description: 'Optional. Used only when creating an account and the token carries no name. Required for a new phone account (see 422 NAME_REQUIRED).',
              example: 'Jane Brown',
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Signed in',
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
                  is_new_user: { type: 'boolean', example: false },
                },
              },
            },
          },
        },
      },
    },
    401: { description: 'Bad, expired or wrong-provider token', content: errorBody('Sign-in could not be verified') },
    403: { description: 'Account suspended', content: errorBody('Your account has been suspended') },
    409: {
      description: 'The email belongs to an account this sign-in cannot attach to',
      content: codedErrorBody('This email is already registered. Sign in the way you first signed up.', 'EMAIL_IN_USE'),
    },
    422: {
      description: 'Validation error, or (phone only) a new account needs a name: retry with "name"',
      content: codedErrorBody('Please enter your name to finish signing up', 'NAME_REQUIRED'),
    },
    429: { description: 'Too many requests from this IP', content: errorBody('Too many sign-in attempts. Please wait a few minutes and try again.') },
    503: { description: 'Firebase is not configured on the server', content: errorBody("This sign-in method isn't available right now") },
  },
});

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
            email: { type: 'string', example: 'john@example.com', nullable: true, description: 'Null for an account created by phone sign-in' },
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
      { name: 'Auth', description: 'Register, login, Google/Facebook/phone sign-in, password reset' },
      { name: 'User', description: 'Profile and preferences' },
      { name: 'Routes', description: 'Navigation route planning' },
      { name: 'Groups', description: 'Shared navigation groups with live locations' },
      { name: 'Reports', description: 'Community safety reports' },
      { name: 'POIs', description: 'Points of interest' },
      { name: 'Emergency', description: 'Emergency alerts, delivered to responders as notifications and push' },
      { name: 'Notifications', description: 'In-app notifications. Every notification is also pushed (FCM) to the recipient\'s registered devices when its category is switched on in /user/preferences. Push data: { type, reference_id, category }, all strings.' },
      { name: 'Members', description: 'Member businesses: shown on the map, and the public membership application (no login)' },
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
      '/auth/google-login': { post: firebaseSignInDoc('Google', 'google.com') },
      '/auth/facebook-login': { post: firebaseSignInDoc('Facebook', 'facebook.com') },
      '/auth/phone-login': { post: firebaseSignInDoc('phone number', 'phone') },
      '/auth/forgot-password': {
        post: {
          tags: ['Auth'],
          summary: 'Email a password reset code',
          description: 'Emails a 6-digit code, valid for 15 minutes, to an email+password account. The code is never returned in the response, and the response is the same whether or not the address is registered. Rate limited to 5 requests per IP per 15 minutes.',
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
              description: 'Accepted. Same response for registered and unregistered addresses.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      message: { type: 'string', example: 'If this email is registered, a reset code has been sent to it. It expires in 15 minutes.' },
                      data: { type: 'object', example: {} },
                    },
                  },
                },
              },
            },
            422: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            429: { description: 'Too many requests from this IP', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            503: { description: "Email is not configured on the server: \"Password reset by email isn't available right now. Please contact support.\"", content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/auth/otp-verify': {
        post: {
          tags: ['Auth'],
          summary: 'Verify the emailed code and set a new password',
          description: 'Five wrong codes void the code; request a new one. new_password follows the /auth/register rules. Rate limited to 10 requests per IP per 15 minutes.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'otp', 'new_password'],
                  properties: {
                    email: { type: 'string', example: 'john@example.com' },
                    otp: { type: 'string', example: '123456', description: 'The 6-digit code from the email' },
                    new_password: { type: 'string', example: 'NewPassword@1', description: 'Min 6 chars, 1 uppercase, 1 number, 1 special symbol' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Password reset successfully' },
            400: { description: 'Invalid, expired, used or voided code; or a wrong code, with the attempts left', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            422: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            429: { description: 'Too many requests from this IP', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
                          preferences: {
                            type: 'object',
                            properties: {
                              alert_police: { type: 'boolean' },
                              alert_construction: { type: 'boolean' },
                              alert_hazards: { type: 'boolean' },
                              alert_traffic: { type: 'boolean' },
                              alert_business: { type: 'boolean' },
                              alert_tourism: { type: 'boolean' },
                              priority_level: { type: 'string', enum: ['critical', 'high', 'low'] },
                              push_emergency: { type: 'boolean', description: 'Push for emergencies: responder alerts, group SOS, safety broadcasts. Default true.' },
                              push_group: { type: 'boolean', description: 'Push for group check-ins and deletions. Default true.' },
                              push_reports: { type: 'boolean', description: 'Push when someone confirms your report. Default true.' },
                              push_app_updates: { type: 'boolean', description: 'Push for informational admin broadcasts. Default true.' },
                              push_promotions: { type: 'boolean', description: 'Push for promotional broadcasts. Default false (opt-in).' },
                              push_weather: { type: 'boolean', description: 'Push when a hurricane or tropical storm comes near the area set with PUT /user/alert-area. Default true.' },
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
        put: {
          tags: ['User'],
          summary: 'Update notification preferences',
          description: 'Every field is optional; an omitted field keeps its stored value, so one switch can be changed on its own. A push_* field that is sent must be a JSON boolean.',
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
                    priority_level: { type: 'string', enum: ['critical', 'high', 'low'] },
                    push_emergency: { type: 'boolean', description: 'Push for emergencies: responder alerts, group SOS, safety broadcasts. Default true.' },
                    push_group: { type: 'boolean', description: 'Push for group check-ins and deletions. Default true.' },
                    push_reports: { type: 'boolean', description: 'Push when someone confirms your report. Default true.' },
                    push_app_updates: { type: 'boolean', description: 'Push for informational admin broadcasts. Default true.' },
                    push_promotions: { type: 'boolean', description: 'Push for promotional broadcasts. Default false (opt-in).' },
                    push_weather: { type: 'boolean', description: 'Push for hurricane and tropical storm alerts. Default true. Setting it false also deletes the stored alert area.' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Updated preferences, in data.preferences' },
            404: { description: 'The account has no preferences row' },
            422: { description: 'A push_* field is not a boolean' },
          },
        },
      },
      '/user/alert-area': {
        put: {
          tags: ['User'],
          summary: 'Set the rough area used for weather alerts',
          description: 'Stores the rough area of the caller, rounded to one decimal place (about 11 km), so the server can push hurricane and tropical storm alerts (NHC feed, checked every 15 minutes; a hurricane within 800 km or a tropical storm within 400 km, once per storm and strength). Kept only while push_weather is on: with it off nothing is stored and data.stored is false. An area not updated for 14 days is not used. Rate limited per account.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['latitude', 'longitude'],
                  properties: {
                    latitude: { type: 'number', minimum: -90, maximum: 90, example: 18.01 },
                    longitude: { type: 'number', minimum: -180, maximum: 180, example: -76.79 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'data.stored is true when the area was saved, false when weather alerts are off' },
            422: { description: 'latitude or longitude missing, not a number, or out of range' },
            429: { description: 'Too many updates' },
          },
        },
      },
      '/user/device-token': {
        post: {
          tags: ['User'],
          summary: 'Register this phone for push notifications',
          description: 'Upserts the FCM registration token. A token already registered to another account is moved to the caller (one app install belongs to whoever is signed in on it). Only the newest 10 devices of an account are kept. Rate limited per account.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token', 'platform'],
                  properties: {
                    token: { type: 'string', minLength: 1, maxLength: 4096, description: 'FCM registration token (trimmed)' },
                    platform: { type: 'string', enum: ['android', 'ios'] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Registered; data.device_token = { id, token, platform, created_at, updated_at }' },
            422: { description: 'Missing or over-long token, or unknown platform' },
            429: { description: 'Too many registrations from this account' },
          },
        },
        delete: {
          tags: ['User'],
          summary: 'Unregister this phone (on sign-out)',
          description: 'Removes the token only if it is registered to the caller. A token that is not registered to the caller is not an error: data.removed is then false.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: { token: { type: 'string', minLength: 1, maxLength: 4096 } },
                },
              },
            },
          },
          responses: {
            200: { description: 'data.removed tells whether a registration was removed' },
            422: { description: 'Missing token' },
          },
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
      '/groups/user/{user_id}': {
        get: {
          tags: ['Groups'],
          summary: 'Get all groups for a user',
          description: 'Returns all active groups the specified user is a member of, ordered by most recently joined.',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'user_id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
              description: 'UUID of the user',
              example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            },
          ],
          responses: {
            200: {
              description: 'List of groups the user belongs to',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          groups: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                id: { type: 'string', format: 'uuid' },
                                group_name: { type: 'string', example: 'Family Trip' },
                                join_code: { type: 'string', example: 'ABC123' },
                                destination_lat: { type: 'number', nullable: true },
                                destination_lng: { type: 'number', nullable: true },
                                destination_address: { type: 'string', nullable: true },
                                created_by: { type: 'string', format: 'uuid' },
                                created_by_name: { type: 'string', example: 'John Doe' },
                                joined_at: { type: 'string', format: 'date-time' },
                                member_status: { type: 'string', example: 'active' },
                                created_at: { type: 'string', format: 'date-time' },
                              },
                            },
                          },
                          total: { type: 'integer', example: 3 },
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
                          members: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, user_id: { type: 'string' }, name: { type: 'string' }, profile_image: { type: 'string', nullable: true }, status: { type: 'string' }, joined_at: { type: 'string' }, current_latitude: { type: 'number', nullable: true, example: 10.6918 }, current_longitude: { type: 'number', nullable: true, example: -61.2225 }, location_updated_at: { type: 'integer', nullable: true, description: 'Unix timestamp ms of last location update' } } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          tags: ['Groups'],
          summary: 'Delete a group (creator only)',
          description: 'Deletes the group and its memberships. Once the row is gone, broadcasts `{ "type": "group_deleted", "group_id": "<id>" }` to the group\'s WebSocket room and writes a `group` notification for every other active member. A notification failure does not fail the delete (`notified` is then -1).',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: {
              description: 'Group deleted',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      message: { type: 'string', example: 'Group deleted' },
                      data: {
                        type: 'object',
                        properties: {
                          delivered_live: { type: 'integer', example: 2, description: 'Other members with an open WebSocket that received the frame' },
                          notified: { type: 'integer', example: 3, description: 'Notification rows written; -1 if that write failed' },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'Group id is not a valid UUID' },
            403: { description: 'Caller is not the group creator' },
            404: { description: 'Group not found' },
          },
        },
      },
      '/groups/{id}/sos': {
        post: {
          tags: ['Groups'],
          summary: 'Raise an SOS to the group',
          description: 'Caller must be an active member. Broadcasts to every open socket in the group room (the sender included):\n\n```json\n{ "type": "sos", "user_id": "uuid", "user_name": "John", "latitude": 10.6918, "longitude": -61.2225, "raised_at": "2026-10-03T12:00:00.000Z", "note": "optional" }\n```\n\n`raised_at` is the client value normalised to UTC, or the server receive time when the client value is missing or not an ISO-8601 date-time with an offset. Also writes an `emergency` notification (no coordinates) for every other active member. A notification failure does not fail the SOS (`notified` is then -1).',
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
                    latitude: { type: 'number', minimum: -90, maximum: 90, example: 10.6918 },
                    longitude: { type: 'number', minimum: -180, maximum: 180, example: -61.2225 },
                    raised_at: { type: 'string', format: 'date-time', example: '2026-10-03T12:00:00.000Z' },
                    note: { type: 'string', maxLength: 500, description: 'Trimmed; longer values are cut to 500 characters' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'SOS sent',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      message: { type: 'string', example: 'SOS sent to the group' },
                      data: {
                        type: 'object',
                        properties: {
                          delivered_live: { type: 'integer', example: 2, description: 'Other members with an open WebSocket that received the frame' },
                          notified: { type: 'integer', example: 3, description: 'Notification rows written; -1 if that write failed' },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'Invalid group id, coordinates or note' },
            403: { description: 'Not a group member' },
          },
        },
      },
      '/groups/{id}/check-in': {
        post: {
          tags: ['Groups'],
          summary: 'Check in (or cancel a check-in) with the group',
          description: 'Caller must be an active member. Broadcasts to every open socket in the group room (the sender included):\n\n```json\n{ "type": "check_in", "user_id": "uuid", "user_name": "John", "checked_in": true, "latitude": 10.6918, "longitude": -61.2225, "at": "2026-10-03T12:00:00.000Z" }\n```\n\n`latitude`/`longitude` appear only when sent. `at` follows the same normalisation and server-time fallback as SOS `raised_at`. A check-in (checked_in true) also writes a `group` notification for every other active member, pushed under the `group` category; a cancellation is live-only.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['checked_in'],
                  properties: {
                    checked_in: { type: 'boolean', example: true },
                    latitude: { type: 'number', minimum: -90, maximum: 90, example: 10.6918, description: 'Send together with longitude, or omit both' },
                    longitude: { type: 'number', minimum: -180, maximum: 180, example: -61.2225 },
                    at: { type: 'string', format: 'date-time', example: '2026-10-03T12:00:00.000Z' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Check-in broadcast; data.delivered_live is the number of other members reached live' },
            400: { description: 'Invalid group id, checked_in or coordinates' },
            403: { description: 'Not a group member' },
          },
        },
      },
      '/ws/groups/location': {
        get: {
          tags: ['Groups'],
          summary: 'WebSocket — real-time group member locations',
          description: `Connect via WebSocket (not HTTP) to receive live location updates for every member in a group.\n\n**URL:** \`wss://caribwayz-api-new.onrender.com/ws/groups/location?token=<JWT>&group_id=<uuid>\`\n\n**Query params (required):**\n- \`token\` — JWT from /auth/login\n- \`group_id\` — UUID of the group to subscribe to\n\n**On connect — server sends:**\n\`\`\`json\n{ "type": "connected", "group_id": "...", "user_id": "..." }\n\`\`\`\n\n**On each member location update — server broadcasts:**\n\`\`\`json\n{\n  "type": "location_update",\n  "user_id": "uuid",\n  "user_name": "John",\n  "current_latitude": 10.6918,\n  "current_longitude": -61.2225,\n  "timestamp": 1720000000000\n}\n\`\`\`\n\nUpdates are triggered automatically whenever a member calls \`POST /groups/{id}/location\`.\n\n**Other frames:** \`sos\` (from \`POST /groups/{id}/sos\`), \`check_in\` (from \`POST /groups/{id}/check-in\`) and \`group_deleted\` (from \`DELETE /groups/{id}\`). The server does not relay messages sent by clients.`,
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' }, description: 'JWT bearer token' },
            { name: 'group_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Group to subscribe to' },
          ],
          responses: {
            101: { description: 'Switching Protocols — WebSocket connection established' },
            4001: { description: 'Missing token or group_id' },
            4003: { description: 'Invalid or expired JWT' },
          },
        },
      },
      '/groups/{id}/invite': {
        post: {
          tags: ['Groups'],
          summary: 'Send group invitations via email',
          description: 'Sends an email with the group join code to one or more addresses. Caller must be an active group member.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: {
                      type: 'array',
                      items: { type: 'string', format: 'email' },
                      example: ['abc@mail.com', 'xyz@mail.com'],
                      description: 'List of email addresses to invite',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Invitations sent successfully' },
            400: { description: 'Validation error — invalid email format or empty array' },
            403: { description: 'Caller is not an active group member' },
            404: { description: 'Group not found' },
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
      '/reports/history/{user_id}': {
        get: {
          tags: ['Reports'],
          summary: 'Get report history for a user',
          description: 'Returns all reports submitted by the specified user. Supports filtering by type and status, with pagination.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'user_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'UUID of the user' },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['police', 'construction', 'hazard', 'traffic', 'other'] }, description: 'Filter by report type' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'expired', 'removed'] }, description: 'Filter by status' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 }, description: 'Number of results per page' },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 }, description: 'Pagination offset' },
          ],
          responses: {
            200: {
              description: 'Paginated report history',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      data: {
                        type: 'object',
                        properties: {
                          reports: { type: 'array', items: { $ref: '#/components/schemas/Report' } },
                          total: { type: 'integer', example: 15 },
                          limit: { type: 'integer', example: 20 },
                          offset: { type: 'integer', example: 0 },
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
          description: 'Each user can confirm a report once, and never their own. Increments confirmed_count and notifies the reporter (a `report` notification, pushed under the `reports` category). A notification failure does not fail the confirmation.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Confirmed — returns updated confirmed_count' },
            409: { description: 'Already confirmed' },
          },
        },
      },

      // ── POIS ─────────────────────────────────────────────────────────────
      '/providers': {
        get: {
          tags: ['POIs'],
          summary: 'Roadside-help places near a position (Services lists)',
          description: 'Repair, towing, tyre, locksmith, parts and fuel places from the CaribWayz roadside directory (OpenStreetMap data, ODbL). covered is false outside the Caribbean territories the directory holds; the app then asks Overpass itself. Elements use the Overpass element format.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'key', in: 'query', required: true, schema: { type: 'string', enum: ['roadside_towing', 'roadside_mechanic', 'roadside_tyres', 'roadside_locksmith', 'roadside_battery', 'roadside_fuel', 'roadside_winch', 'roadside_overheating'] } },
            { name: 'lat', in: 'query', required: true, schema: { type: 'number' }, example: 18.0179 },
            { name: 'lng', in: 'query', required: true, schema: { type: 'number' }, example: -76.8099 },
            { name: 'radius', in: 'query', schema: { type: 'number', default: 5000 }, description: 'Radius in metres, 50 to 50000' },
          ],
          responses: {
            200: { description: '{ covered, territory, dataset, elements[] } nearest first' },
            400: { description: 'Unknown key or invalid coordinate' },
            401: { description: 'No or invalid token' },
          },
        },
      },
      '/shelters': {
        get: {
          tags: ['POIs'],
          summary: 'Designated disaster shelters and evacuation points near a position',
          description: 'Shelters and evacuation points from the CaribWayz shelter directory (OpenStreetMap data, ODbL). Says where a shelter is designated, never whether it is open. covered is false outside the Caribbean territories the directory holds; the app then asks Overpass itself. Elements use the Overpass element format.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'lat', in: 'query', required: true, schema: { type: 'number' }, example: 18.0179 },
            { name: 'lng', in: 'query', required: true, schema: { type: 'number' }, example: -76.8099 },
            { name: 'radius', in: 'query', schema: { type: 'number', default: 30000 }, description: 'Radius in metres, 50 to 50000' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 40 }, description: 'Most shelters returned, 1 to 200' },
          ],
          responses: {
            200: { description: '{ covered, territory, dataset, elements[] } nearest first' },
            400: { description: 'Invalid coordinate, radius or limit' },
            401: { description: 'No or invalid token' },
          },
        },
      },
      '/members/nearby': {
        get: {
          tags: ['Members'],
          summary: 'Member businesses near a position, nearest first',
          description: 'Only listed members whose membership is active and not past its expiry. At most 50. No login.',
          parameters: [
            { name: 'lat', in: 'query', required: true, schema: { type: 'number', minimum: -90, maximum: 90 }, example: 18.0179 },
            { name: 'lng', in: 'query', required: true, schema: { type: 'number', minimum: -180, maximum: 180 }, example: -76.8099 },
            { name: 'radius_m', in: 'query', schema: { type: 'integer', default: 2000 }, description: 'Radius in metres, clamped to 50..20000' },
          ],
          responses: {
            200: {
              description: 'data.members',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          members: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                id: { type: 'string', format: 'uuid' },
                                name: { type: 'string' },
                                category: { type: 'string', nullable: true },
                                latitude: { type: 'number' },
                                longitude: { type: 'number' },
                                address: { type: 'string', nullable: true },
                                phone: { type: 'string', nullable: true },
                                website: { type: 'string', nullable: true },
                                description: { type: 'string', nullable: true },
                                promo_text: { type: 'string', nullable: true, description: 'Null when empty or past promo_expires_at' },
                                distance_m: { type: 'integer' },
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
            400: { description: 'Missing or out-of-range lat/lng, or radius_m not a whole number' },
          },
        },
      },
      '/members/tiers': {
        get: {
          tags: ['Members'],
          summary: 'Active membership fee tiers by employee count',
          description: 'max_employees null means no upper bound; annual_fee null means the fee is not set yet. No login.',
          responses: { 200: { description: 'data.tiers: [{ id, name, min_employees, max_employees, annual_fee, currency, is_provisional }] in display order' } },
        },
      },
      '/members/apply': {
        post: {
          tags: ['Members'],
          summary: 'Apply to become a member business (public membership page)',
          description: 'The server picks the tier from employee_count and stores its fee as quoted_fee. Emails the CaribWayz contact address when SMTP is configured; a failed email never fails the request. Limited to 5 per hour per IP. No login.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'business_name', 'category', 'address', 'phone',
                    'contact_name', 'contact_position', 'contact_phone', 'email', 'employee_count', 'accept_terms',
                  ],
                  properties: {
                    business_name: { type: 'string', minLength: 2, maxLength: 200, description: 'Registered business name' },
                    trading_name: { type: 'string', maxLength: 200, description: 'Trading name, if different; the app shows it' },
                    category: { type: 'string', maxLength: 100 },
                    description: { type: 'string', maxLength: 1000 },
                    address: { type: 'string', maxLength: 500, description: 'Physical business address' },
                    phone: { type: 'string', maxLength: 40, description: 'Business telephone number' },
                    business_email: { type: 'string', format: 'email' },
                    website: { type: 'string', maxLength: 500, description: 'Website or social media link (http or https)' },
                    contact_name: { type: 'string', maxLength: 200, description: 'Owner or authorized representative' },
                    contact_position: { type: 'string', maxLength: 100, description: 'Position or relationship to the business' },
                    contact_phone: { type: 'string', maxLength: 40 },
                    email: { type: 'string', format: 'email', description: 'Email of the owner or representative' },
                    employee_count: { type: 'integer', minimum: 1, maximum: 1000000 },
                    accept_terms: { type: 'boolean', enum: [true], description: 'Acceptance of the Business Membership Policy and the Terms; stored as terms_accepted_at' },
                    message: { type: 'string', maxLength: 2000 },
                    latitude: { type: 'number', description: 'With longitude, or neither' },
                    longitude: { type: 'number' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'data = { application_id, tier: { name, annual_fee, currency, is_provisional } or null when no tier fits, payment_instructions (may be "") }' },
            400: { description: 'Validation failed' },
            429: { description: 'Too many applications from this IP' },
          },
        },
      },
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
          description: 'Creates an emergency record and notifies every approved responder and admin: an `emergency` notification row each, and an FCM push (channel `caribwayz_alerts`) to their registered devices when they have push_emergency on. `data.responders_notified` is the number of responders notified, or -1 when delivery failed.',
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
            201: { description: 'Emergency alert triggered; data = { alert, responders_notified }' },
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
      '/admin/broadcasts': {
        post: {
          tags: ['Admin'],
          summary: 'Send a broadcast to every active account',
          description: 'Saves the broadcast and sends every active account a `system` notification, pushed under a category chosen by type: disaster, hazard, emergency and road_closure use `emergency`; info uses `app_updates`; promotion uses `promotions` and goes only to accounts that turned promotional notifications on (no notification row for anyone else). Accounts carry no parish, so a parish broadcast goes to everyone with the parish prefixed to the title.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'message', 'type'],
                  properties: {
                    title: { type: 'string', maxLength: 200 },
                    message: { type: 'string' },
                    type: { type: 'string', enum: ['disaster', 'hazard', 'emergency', 'road_closure', 'info', 'promotion'] },
                    scope: { type: 'string', example: 'island_wide', description: 'island_wide (default) or parish' },
                    parish: { type: 'string' },
                    severity: { type: 'string', example: 'warning', description: 'info (default), warning or critical' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'data = { broadcast, notified }; notified is the number of accounts notified, or -1 when delivery failed (the broadcast is saved either way)' },
            422: { description: 'Missing title or message, or unknown type' },
          },
        },
        get: {
          tags: ['Admin'],
          summary: 'List the last 100 broadcasts',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'data.broadcasts' } },
        },
      },
      '/admin/businesses': {
        post: {
          tags: ['Admin'],
          summary: 'Add a business (member listing)',
          description: 'membership_status defaults to pending. A business is shown on the map only when is_active, membership_status is active and membership_expires_at is empty or in the future.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'latitude', 'longitude'],
                  properties: {
                    name: { type: 'string', example: 'Island Grill' },
                    latitude: { type: 'number', example: 18.0179 },
                    longitude: { type: 'number', example: -76.8099 },
                    category: { type: 'string', example: 'restaurant' },
                    address: { type: 'string' },
                    phone: { type: 'string' },
                    website: { type: 'string' },
                    description: { type: 'string' },
                    image_url: { type: 'string' },
                    is_active: { type: 'boolean' },
                    tier_id: { type: 'integer', nullable: true },
                    employee_count: { type: 'integer', nullable: true },
                    contact_email: { type: 'string', nullable: true },
                    membership_status: { type: 'string', enum: ['pending', 'active', 'suspended', 'expired', 'cancelled'] },
                    membership_expires_at: { type: 'string', format: 'date-time', nullable: true },
                    promo_text: { type: 'string', maxLength: 280, nullable: true },
                    promo_expires_at: { type: 'string', format: 'date-time', nullable: true },
                    membership_tier: { type: 'string', nullable: true, description: 'Legacy free text' },
                    business_size: { type: 'string', nullable: true, description: 'Legacy free text' },
                    registered_name: { type: 'string', maxLength: 200, nullable: true },
                    business_email: { type: 'string', nullable: true },
                    contact_name: { type: 'string', maxLength: 200, nullable: true },
                    contact_position: { type: 'string', maxLength: 100, nullable: true },
                    contact_phone: { type: 'string', maxLength: 40, nullable: true },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'data.business' }, 400: { description: 'Unknown tier_id' }, 422: { description: 'Validation failed' } },
        },
        get: {
          tags: ['Admin'],
          summary: 'Get all businesses, newest first',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'membership_status', in: 'query', schema: { type: 'string', enum: ['pending', 'active', 'suspended', 'expired', 'cancelled'] } },
            { name: 'is_active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          ],
          responses: { 200: { description: 'data.businesses, each with tier_name' } },
        },
      },
      '/admin/businesses/{id}': {
        patch: {
          tags: ['Admin'],
          summary: 'Update any of a business\'s fields',
          description: 'Only the fields sent change. Send null (or "") to clear an optional field such as promo_text.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: {
                    name: { type: 'string', example: 'Island Grill' },
                    latitude: { type: 'number', example: 18.0179 },
                    longitude: { type: 'number', example: -76.8099 },
                    category: { type: 'string', example: 'restaurant' },
                    address: { type: 'string' },
                    phone: { type: 'string' },
                    website: { type: 'string' },
                    description: { type: 'string' },
                    image_url: { type: 'string' },
                    is_active: { type: 'boolean' },
                    tier_id: { type: 'integer', nullable: true },
                    employee_count: { type: 'integer', nullable: true },
                    contact_email: { type: 'string', nullable: true },
                    membership_status: { type: 'string', enum: ['pending', 'active', 'suspended', 'expired', 'cancelled'] },
                    membership_expires_at: { type: 'string', format: 'date-time', nullable: true },
                    promo_text: { type: 'string', maxLength: 280, nullable: true },
                    promo_expires_at: { type: 'string', format: 'date-time', nullable: true },
                    membership_tier: { type: 'string', nullable: true, description: 'Legacy free text' },
                    business_size: { type: 'string', nullable: true, description: 'Legacy free text' },
                    registered_name: { type: 'string', maxLength: 200, nullable: true },
                    business_email: { type: 'string', nullable: true },
                    contact_name: { type: 'string', maxLength: 200, nullable: true },
                    contact_position: { type: 'string', maxLength: 100, nullable: true },
                    contact_phone: { type: 'string', maxLength: 40, nullable: true },
            } } } },
          },
          responses: { 200: { description: 'data.business' }, 400: { description: 'Nothing to update, or unknown tier_id' }, 404: { description: 'Business not found' }, 422: { description: 'Validation failed' } },
        },
      },
      '/admin/membership-tiers': {
        get: {
          tags: ['Admin'],
          summary: 'Every membership tier, inactive ones too',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'data.tiers' } },
        },
        post: {
          tags: ['Admin'],
          summary: 'Add a membership tier',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name', 'min_employees'], properties: {
                    name: { type: 'string', maxLength: 100 },
                    min_employees: { type: 'integer', minimum: 1 },
                    max_employees: { type: 'integer', nullable: true, description: 'Null = no upper bound' },
                    annual_fee: { type: 'number', nullable: true, description: 'Null = fee not set yet' },
                    currency: { type: 'string', example: 'USD' },
                    is_provisional: { type: 'boolean' },
                    sort_order: { type: 'integer', nullable: true },
                    is_active: { type: 'boolean' },
            } } } },
          },
          responses: { 201: { description: 'data.tier' }, 400: { description: 'max_employees below min_employees' }, 422: { description: 'Validation failed' } },
        },
      },
      '/admin/membership-tiers/{id}': {
        patch: {
          tags: ['Admin'],
          summary: 'Update a membership tier',
          description: 'Only the fields sent change. A fee change applies to new applications; quoted fees already stored stay.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: {
                    name: { type: 'string', maxLength: 100 },
                    min_employees: { type: 'integer', minimum: 1 },
                    max_employees: { type: 'integer', nullable: true, description: 'Null = no upper bound' },
                    annual_fee: { type: 'number', nullable: true, description: 'Null = fee not set yet' },
                    currency: { type: 'string', example: 'USD' },
                    is_provisional: { type: 'boolean' },
                    sort_order: { type: 'integer', nullable: true },
                    is_active: { type: 'boolean' },
            } } } },
          },
          responses: { 200: { description: 'data.tier' }, 404: { description: 'Tier not found' }, 422: { description: 'Validation failed' } },
        },
      },
      '/admin/membership-applications': {
        get: {
          tags: ['Admin'],
          summary: 'Membership applications, newest first',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['new', 'invoiced', 'paid', 'rejected'] } }],
          responses: { 200: { description: 'data = { applications (each with tier_name), summary: count per status }' } },
        },
      },
      '/admin/membership-applications/{id}': {
        patch: {
          tags: ['Admin'],
          summary: 'Set an application\'s status or notes',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: {
              status: { type: 'string', enum: ['new', 'invoiced', 'paid', 'rejected'] },
              admin_notes: { type: 'string', nullable: true },
            } } } },
          },
          responses: { 200: { description: 'data.application' }, 404: { description: 'Application not found' }, 422: { description: 'Validation failed' } },
        },
      },
      '/admin/membership-applications/{id}/activate': {
        post: {
          tags: ['Admin'],
          summary: 'Activate a paid membership',
          description: 'Creates the member business from the application (or renews the linked one, refused with 409 while it is suspended) with membership_status active and expiry now + months, marks the application paid and links business_id, in one transaction. latitude/longitude may be left out when the application or linked business already has a location.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: {
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              months: { type: 'integer', default: 12, minimum: 1, maximum: 120 },
            } } } },
          },
          responses: {
            200: { description: 'data = { business, application }' },
            400: { description: 'No location on the application and none given' },
            404: { description: 'Application not found' },
            422: { description: 'Validation failed' },
          },
        },
      },
      '/admin/membership-settings': {
        get: {
          tags: ['Admin'],
          summary: 'Payment instructions and contact email for the membership page',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'data.settings = { payment_instructions, contact_email, updated_at }' } },
        },
        put: {
          tags: ['Admin'],
          summary: 'Save the payment instructions and/or contact email',
          description: 'A field left out keeps its value. Empty payment instructions make the membership page say the team will email an invoice. Application notices go to contact_email, or to ADMIN_EMAIL when it is empty.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: {
              payment_instructions: { type: 'string', maxLength: 5000 },
              contact_email: { type: 'string', nullable: true },
            } } } },
          },
          responses: { 200: { description: 'data.settings' }, 422: { description: 'Validation failed' } },
        },
      },
    },
  },
  apis: [],
};

module.exports = swaggerJsdoc(options);
