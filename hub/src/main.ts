import { Zigbee2Mqtt } from "./adapters/zigbee2mqtt.ts";
import { Hub } from "./hub.ts";
import { startServer } from "./server.ts";
import { ENV } from "./env.ts";
import pkg from "../package.json" with { type: "json" };

if(ENV.dryRun) console.log('Dry run: the lights are logged, not set');

const hub = new Hub(pkg.version, [
    new Zigbee2Mqtt({
        url: ENV.mqttUrl,
        username: ENV.mqttUsername,
        password: ENV.mqttPassword,
        baseTopic: ENV.baseTopic,
        dryRun: ENV.dryRun
    })
]);
const server = startServer(hub);

function shutdown() {
    hub.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
