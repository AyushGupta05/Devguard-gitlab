export function requireRedisUrl() {
  const value = process.env.REDIS_URL;

  if (!value) {
    throw new Error("REDIS_URL is required");
  }

  return value;
}
