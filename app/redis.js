const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

module.exports = redis;