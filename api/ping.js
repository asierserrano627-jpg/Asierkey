module.exports = (req, res) => {
  res.json({
    ok: true,
    upstash: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  });
};
