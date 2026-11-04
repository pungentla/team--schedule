'use strict';

/** 给每个请求打上 requestId，便于日志串联 */

const { shortId } = require('../utils/security');

function requestId(req, res, next) {
  const incoming = req.get('X-Request-Id');
  req.requestId = incoming && incoming.length <= 64 ? incoming : shortId(8);
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

module.exports = { requestId };
