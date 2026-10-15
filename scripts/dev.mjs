import http from 'node:http';
import handler from '../api/index.mjs';
http.createServer(handler).listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log('Tools: http://localhost:3000 — Scouting: /scouting'));
