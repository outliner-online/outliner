// Private smoke fixture. No production Functions code or authentication settings.
const { onRequest } = require("/prepared/source/functions/node_modules/firebase-functions/v2/https");
exports.preparedSmoke = onRequest((_req, res) => res.json({ preparedFixture: true }));
