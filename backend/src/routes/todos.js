'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { intParam } = require('../utils/validate');
const todos = require('../services/todoService');

const router = express.Router();
router.use(requireAuth, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', (req, res) => res.json({ data: todos.list(req.user, req.query) }));
router.get('/recent', (req, res) => res.json({ data: todos.recent(req.user) }));
router.get('/tags', (req, res) => res.json({ data: todos.tags(req.user) }));
router.get('/unread', (req, res) => res.json({ data: todos.unread(req.user) }));
router.post('/', (req, res) => res.status(201).json({ data: todos.create(req.body || {}, req.user) }));
router.get('/:id', (req, res) => res.json({ data: todos.get(intParam(req.params.id, '待办编号'), req.user) }));
router.put('/:id', (req, res) => res.json({ data: todos.update(intParam(req.params.id, '待办编号'), req.body || {}, req.user) }));
router.put('/:id/completion', (req, res) => res.json({ data: todos.complete(intParam(req.params.id, '待办编号'), req.body || {}, req.user) }));
router.put('/:id/archive', (req, res) => res.json({ data: todos.archive(intParam(req.params.id, '待办编号'), req.body?.archived, req.user) }));
router.put('/:id/reminder', (req, res) => res.json({ data: todos.setReminder(intParam(req.params.id, '待办编号'), req.body?.remindAt, req.user) }));
router.put('/:id/items/:itemId', (req, res) => res.json({ data: todos.setItem(intParam(req.params.id, '待办编号'), intParam(req.params.itemId, '子任务编号'), req.body?.done, req.user) }));
router.put('/:id/read', (req, res) => { todos.markRead(intParam(req.params.id, '待办编号'), req.user); res.status(204).end(); });
router.delete('/:id', (req, res) => { todos.remove(intParam(req.params.id, '待办编号'), req.user); res.status(204).end(); });
module.exports = router;
