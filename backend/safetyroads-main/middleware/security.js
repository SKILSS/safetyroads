'use strict';

/**
 * SafetyRoad security middleware
 * Compatible with Express.
 */

function securityMiddleware(req, res, next) {
    // Basic security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
        'Permissions-Policy',
        'geolocation=(self), microphone=(), camera=()'
    );

    // Basic CSP.
    // Kept permissive enough for the existing frontend/map application.
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
            "style-src 'self' 'unsafe-inline' https:",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data: https:",
            "connect-src 'self' https: wss:",
            "frame-src 'self' https:"
        ].join('; ')
    );

    next();
}

module.exports = securityMiddleware;
module.exports.securityMiddleware = securityMiddleware;
