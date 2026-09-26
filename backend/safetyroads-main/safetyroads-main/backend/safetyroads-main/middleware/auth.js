const jwt = require("jsonwebtoken");

function getToken(req) {
  const cookieToken = req.cookies?.session;
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function verifyToken(token) {
  if (!token || !process.env.JWT_SECRET) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch { return null; }
}

function requireAuth(req, res, next) {
  const user = verifyToken(getToken(req));
  if (!user) return res.status(401).json({ error: "Login required." });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only." });
    next();
  });
}

function optionalAuth(req, res, next) {
  req.user = verifyToken(getToken(req));
  next();
}

module.exports = { requireAuth, requireAdmin, optionalAuth, getToken };
