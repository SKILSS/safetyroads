// Express 4 does not catch rejected promises thrown inside an async route
// handler — without this, a DB hiccup (or any thrown error) in an async
// handler leaves the request hanging with no response until the client
// times out, instead of returning a clean error. Wrap every async handler
// with this so failures reach the error-handling middleware in server.js.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
