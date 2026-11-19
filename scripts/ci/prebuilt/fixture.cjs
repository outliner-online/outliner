// Private smoke fixture. No production Functions code or authentication settings.
const { loadPinnedHttps } = require("./pinned-functions.cjs");
const { onRequest } = loadPinnedHttps("/prepared/source");
exports.preparedSmoke = onRequest((_req, res) => res.json({ preparedFixture: true }));
