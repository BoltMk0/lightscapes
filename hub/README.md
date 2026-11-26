# Lightscapes hub

The hub drives Zigbee lights, and reads Zigbee buttons, for the app it connects to (such as Clockmaker). It runs on a
small computer next to the lights, such as a Raspberry Pi, with [Zigbee2MQTT](https://www.zigbee2mqtt.io/) (which
drives the Zigbee USB adapter) and the Mosquitto MQTT broker the two talk through. The hub only connects *out*, to the
app, so it works on any network. With Tailscale on it, the app can stay on your tailnet.

```
 Zigbee adapter ── Zigbee2MQTT ── Mosquitto ── hub ──(Tailscale)──▶ app (e.g. Clockmaker)
                     :8080                     :8090
```

Everything the lights do (scenes, spectrums, reactions, buttons) is set up in the app. In Clockmaker, that's
*Settings → Lightscapes*; see its guide, `doc/lightscapes.md`. The hub's own page only has its connection, and shows
its lights, buttons and what it's doing.

## Setting up

You'll need Docker with Compose, a Zigbee USB adapter Zigbee2MQTT supports, and a clone of this repository. The image
is built from the repository root, as the hub is built with the library there. From this folder (`hub/`):

1. **Find the adapter** by its stable path:

   ```sh
   ls -l /dev/serial/by-id/
   ```

2. **Configure:**

   ```sh
   cp .env.example .env            # then set ZIGBEE_ADAPTER (and the rest, if you like)
   mkdir -p data/zigbee2mqtt
   cp zigbee2mqtt/configuration.yaml data/zigbee2mqtt/
   ```

   If Zigbee2MQTT can't tell which adapter you have, uncomment its `adapter:` line in
   `data/zigbee2mqtt/configuration.yaml`.

3. **Start it:**

   ```sh
   docker compose up -d --build
   ```

4. **Pair your lights and buttons** in Zigbee2MQTT's page, `http://<this computer>:8080`:
   - Click *Permit join*, then put each device into pairing mode.
   - Give each one a name you'll recognise, like `table-lamp` or `st-button`.
   - For lights that should change together, make a *group*: it changes them all with one message, so they stay
     in step.

5. **Connect it to the app** on the hub's page, `http://<this computer>:8090`:
   - Set **Address** to the app's Lightscapes address, as this computer reaches it. For Clockmaker, that's its address
     followed by `/lightscapes`, e.g. `http://homelab:3000/lightscapes`. Give the hub a name you'll recognise.
   - The hub asks to connect. Approve it in the app (Clockmaker: *Settings → Lightscapes*).
   - Pick the game it follows in the app (Clockmaker: the game's **Lights** on *Play*).

From then on, the hub starts with the computer, connects to the app, and sets the lights as the app asks.

### Coming from an older Lightscapes

A hub that was set up before the app drove it (with its own scenes, spectrums, bells and buttons) still finds its
Clockmaker address in its old settings, and connects there. Once it's approved, its old settings can be imported as a
lighting preset in *Settings → Lightscapes*. The old API token isn't used any more, and can be revoked in Clockmaker.

## Settings

| `.env` | |
| --- | --- |
| `ZIGBEE_ADAPTER` | The adapter's `/dev/serial/by-id/...` path. |
| `LIGHTSCAPES_PASSWORD` | Asked for by the hub's page (any user name). Empty for none. |
| `BIND_ADDRESS` | The address both pages listen on. Use this computer's Tailscale address (`tailscale ip -4`) to keep them off the venue's network. Docker can't start the containers until that address exists, so Tailscale must be up first. |
| `TZ` | The time zone, for the logs. |

The hub also reads `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` and `Z2M_BASE_TOPIC` (`zigbee2mqtt` by default), and
`DRY_RUN=1`, which logs what it would send to the lights instead of sending it. In `data/lightscapes` it keeps:
- `hub.json`: its id, secret, name and the app's address. Deleting it makes it a new hub, to be approved again.
- `assign.json`: what the app last asked of it, to put the lights back after a restart before it's reconnected.

## Security

The hub is known to the app by an id and a secret it makes the first time it runs, and it only drives lights once the
app has approved it. The app keeps only a hash of the secret.

Mosquitto has no logins and publishes no ports, so only Zigbee2MQTT and the hub can reach it, over Compose's own
network.

The two pages listen on every network by default:
- Set `LIGHTSCAPES_PASSWORD` to protect the hub's page.
- Set `BIND_ADDRESS` to keep both pages to your tailnet.
- Zigbee2MQTT's page has its own `frontend.auth_token` option, to ask for a password.

## Troubleshooting

- **"Waiting for approval".** Approve the hub in the app. A hub not approved within a day is forgotten; it then asks
  again.
- **"Turned away".** It was rejected or removed in the app. Click **Ask again** on its page once you want it back.
- **The app can't be reached by its Tailscale name.** The container may not resolve MagicDNS names. Use the Tailscale
  IP address instead, or uncomment the `dns:` lines in `docker-compose.yml`.
- **Zigbee2MQTT: offline.** Check `docker compose logs zigbee2mqtt`. It's usually the adapter path, or the adapter type.
- **Rootless Docker** (Docker run as your own user) can only pass the adapter through if your user can open it. The
  adapter belongs to `root:dialout` by default. A udev rule giving it to your user fixes that; use the `serial` from
  `udevadm info -a -n /dev/ttyUSB0`, then unplug and replug the adapter:

  ```sh
  echo 'SUBSYSTEM=="tty", ATTRS{serial}=="<serial>", OWNER="<your user>"' | sudo tee /etc/udev/rules.d/99-zigbee-adapter.rules
  sudo udevadm control --reload
  ```
- **A light ignores colours.** Some bulbs only do white, or only do brightness. The hub shows the nearest it can, and
  Clockmaker's preset editor warns when a light can't do what it's set to.

## Developing

```sh
npm install
npm run check     # type-checks, along with the library it's built with
npm test
docker compose up -d mosquitto-dev   # an MQTT broker on localhost:1883, without Zigbee2MQTT or the adapter
npm run dev       # builds, then runs on :8090 with DRY_RUN, against the broker on localhost:1883
```

- **The app:** point the hub at a Clockmaker dev server's `/lightscapes` (`npm run dev` in Clockmaker), and approve it
  there.
- **Testing without Zigbee hardware:** publish Zigbee2MQTT's topics to the broker yourself, e.g. a retained
  `zigbee2mqtt/bridge/devices` list, and `{"action":"single"}` on a button's topic.
