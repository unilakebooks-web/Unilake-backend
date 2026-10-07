import http from 'http'
import app from './app.js';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { setupWebSocket } from './websocket/wsServer.js';
import { initJobs } from './jobs/workers/index.js';
import "./lib/razorpay.js";


const server = http.createServer(app) 
setupWebSocket(server)
initJobs();

server.listen(config.port, () => {
  logger.info(`Server is running in on port ${config.port}`);
});
