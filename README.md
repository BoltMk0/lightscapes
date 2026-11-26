# Lightscapes

Lighting that follows an app. A **hub**, on a small computer next to the lights, drives them; the **app** it connects
to (such as Clockmaker) tells it what to show. This repository has both halves:

- **[`hub/`](hub/README.md):** the hub, with Zigbee2MQTT as its first adapter. Installing it is covered there.
- **The library** (this folder), `@boltmk0/lightscapes`, which apps and the hub share:
  - `@boltmk0/lightscapes/protocol`: the messages between a hub and its app, checked at runtime.
  - `@boltmk0/lightscapes/controller`: the app's side of the connection. Hubs ask to connect and are approved, then
    each is sent what to show over an event stream, and posts its lights, their states and button presses back.
  - `@boltmk0/lightscapes/color`: whites (in kelvin) and colours, and how lights fade along a timeline.

## How it works

The app sends a hub a **program** (named scenes, and timelines of colours to fade through) and a stack of **layers**:
each a scene, with a priority and optionally a clock that moves its timelines along. For each light, the
highest-priority layer that names it wins; lights no layer names are left as they are. **Cues** are layers that flash
for a moment (fading in, holding, and fading back), now or at a time the app gives. The hub does the fading and timing
itself, so the app only sends something when it changes.

Values are generic: brightness 0–1, whites in kelvin, and lights named by their adapter, like `z2m:Hall`. Each adapter
says what its lights can do, and the hub shows the nearest a light can of what it's asked.

The hub connects out to the app's address with `POST <address>/connect`, which answers with an event stream, and
posts back to `<address>/messages`, both with `Authorization: Bearer <hub id>.<secret>`.

## Using the library

It's installed from this repository by tag, not from npm:

```sh
npm install github:BoltMk0/lightscapes#semver:^1.0.0
```

npm 12 only fetches git dependencies when told to, and builds this one when it's installed. In the app's `.npmrc`:

```ini
allow-git=root
```

An app hands the controller its two routes. For example, with SvelteKit:

```ts
// src/routes/lightscapes/connect/+server.ts
export const POST = ({ request }) => controller.handleConnect(request);
// src/routes/lightscapes/messages/+server.ts
export const POST = ({ request }) => controller.handleMessages(request);
```

and makes it with a store for the hubs and what to send each one:

```ts
import { LightscapesController } from '@boltmk0/lightscapes/controller';

const controller = new LightscapesController({
    store: { load: () => readHubs(), save: hubs => writeHubs(hubs) },
    assignmentFor: hubId => ({ following: null, program: { scenes: {}, timelines: {}, fadeSeconds: 2 }, layers: [] })
});
controller.on('change', hubId => { /* a hub asked to connect, came online or went offline */ });
controller.on('input', (hubId, input) => { /* a button was pressed */ });
```

## Developing

```sh
npm install
npm run check
npm test
npm run build     # dist/, as apps install it
```

Releases are tagged `vX.Y.Z`; apps follow a semver range of the tags.
