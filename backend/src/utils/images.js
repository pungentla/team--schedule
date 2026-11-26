'use strict';
const { requireString } = require('./validate');
const { badRequest } = require('./errors');
const MAX_IMAGE_BYTES = 480 * 1024;

function parseImage(value) {
  const encoded = requireString(value, '图片', { max: Math.ceil(MAX_IMAGE_BYTES / 3) * 4 });
  const content = Buffer.from(encoded, 'base64');
  if (content.length > MAX_IMAGE_BYTES || content.toString('base64') !== encoded) throw badRequest('图片数据无效或过大');
  if (content.subarray(0, 3).toString('hex') === 'ffd8ff') return { content, mimeType: 'image/jpeg' };
  if (content.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return { content, mimeType: 'image/png' };
  if (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP') return { content, mimeType: 'image/webp' };
  throw badRequest('图片仅支持 JPG、PNG 或 WebP');
}

module.exports = { parseImage };
