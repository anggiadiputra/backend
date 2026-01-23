export const openApiSpec = {
    openapi: '3.0.0',
    info: {
        title: 'OneTeam Domain Platform API',
        version: '1.0.0',
        description: 'Documentation for OneTeam Domain Management & Reseller API',
    },
    servers: [
        {
            url: 'http://localhost:3000',
            description: 'Local development server',
        },
    ],
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
            },
        },
        schemas: {
            Error: {
                type: 'object',
                properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string' },
                    message: { type: 'string' },
                },
            },
            Success: {
                type: 'object',
                properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string' },
                },
            },
        },
    },
    security: [
        {
            bearerAuth: [],
        },
    ],
    paths: {
        '/api/auth/login': {
            post: {
                tags: ['Authentication'],
                summary: 'Send OTP to email',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email'],
                                properties: {
                                    email: { type: 'string', format: 'email' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'OTP sent successfully',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
                    },
                },
            },
        },
        '/api/auth/verify': {
            post: {
                tags: ['Authentication'],
                summary: 'Verify OTP and get tokens',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email', 'token'],
                                properties: {
                                    email: { type: 'string', format: 'email' },
                                    token: { type: 'string', example: '123456' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Verification successful',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        data: {
                                            type: 'object',
                                            properties: {
                                                user: { type: 'object' },
                                                session: { type: 'object' },
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
        '/api/auth/me': {
            get: {
                tags: ['Authentication'],
                summary: 'Get current user profile',
                security: [{ bearerAuth: [] }],
                responses: {
                    200: { description: 'Profile data retrieved' },
                    401: { description: 'Unauthorized' },
                },
            },
        },
        '/api/auth/sessions': {
            get: {
                tags: ['Sessions'],
                summary: 'List active login sessions',
                security: [{ bearerAuth: [] }],
                responses: {
                    200: { description: 'List of sessions' },
                },
            },
        },
        '/api/auth/sessions/{id}': {
            delete: {
                tags: ['Sessions'],
                summary: 'Revoke a specific session',
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
                ],
                security: [{ bearerAuth: [] }],
                responses: {
                    200: { description: 'Session revoked' },
                },
            },
        },
        '/api/rdash/domains/availability': {
            get: {
                tags: ['Domains'],
                summary: 'Check domain availability',
                parameters: [
                    { name: 'domain', in: 'query', required: true, schema: { type: 'string' } }
                ],
                responses: {
                    200: { description: 'Availability result' },
                },
            },
        },
        '/api/pricing/tld': {
            get: {
                tags: ['Pricing'],
                summary: 'Get TLD pricing list',
                responses: {
                    200: { description: 'List of pricing' },
                },
            },
        },
        '/api/logs': {
            get: {
                tags: ['Audit Logs'],
                summary: 'Get audit logs (Admin only)',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
                    { name: 'action', in: 'query', schema: { type: 'string' } },
                ],
                responses: {
                    200: { description: 'List of logs' },
                },
            },
        },
    },
};
