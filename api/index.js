const express = require('express');

const app = express();

app.use((req, res) => {
    res.status(410).json({
        success: false,
        error: 'api/index.js is disabled. Vercel routes /api/* to server.js.'
    });
});

module.exports = app;
