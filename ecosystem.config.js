module.exports = {
    apps: [
        {
            name: 'wa-bot-service',
            script: 'server.js',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production',
                PORT: 3001,
                LARAVEL_URL: 'http://localhost:8000',
            },
        },
    ],
};
